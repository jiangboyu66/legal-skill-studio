import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPath } from '../../shared/schema';
import type {
  EvalCase,
  EvalCaseResult,
  EvalMetrics,
  EvalRun,
  EvalSetInfo,
  FeedbackStats,
  MaterialDocument,
  Org,
  RulePackSnapshot,
  RunWarning,
  SkillConfig,
  User,
} from '../../shared/types';
import { AppError, Errors, toErrorInfo } from '../errors';
import { paginate } from '../services/documents/text';
import { locate } from './grounding';
import { decide } from './permissions';
import type { Runtime } from './runtime';
import { executeSkill, type PackForRun } from './skills';
import { rulePackStatus } from './workflow/engine';

/**
 * Evaluation (the guide's eval-driven loop): a labelled set of fictional materials with expected
 * findings and known false positives, split into train / holdout. A skill version is run on every
 * case and scored: recall, precision, F2 (recall-weighted — missing an issue is worse than an extra
 * one), quote-verification rate, unknown-rule rate, must-not-flag hits, cost and latency.
 */

export interface EvalSet {
  id: string;
  name: string;
  description: string;
  labelledBy: string;
  target: { listPath: string; ruleIdField: string; quoteField: string };
  cases: EvalCase[];
}

export const EVAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata', 'eval');

let cache: EvalSet[] | undefined;
export function loadEvalSets(dir = EVAL_DIR): EvalSet[] {
  if (cache && dir === EVAL_DIR) return cache;
  const sets = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as EvalSet)
    : [];
  if (dir === EVAL_DIR) cache = sets;
  return sets;
}

export function evalSetInfo(s: EvalSet): EvalSetInfo {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    labelledBy: s.labelledBy,
    target: s.target,
    counts: {
      train: s.cases.filter((c) => c.split === 'train').length,
      holdout: s.cases.filter((c) => c.split === 'holdout').length,
      expected: s.cases.reduce((n, c) => n + c.expected.length, 0),
    },
  };
}

/** An eval set applies to a skill whose finding list matches its target (list path, rule-id and quote fields). */
export function evalSetFor(cfg: SkillConfig, sets = loadEvalSets()): EvalSet | undefined {
  const v = cfg.verification;
  if (!v?.enabled && !v?.listPath) return undefined;
  return sets.find((s) => s.target.listPath === v.listPath && s.target.ruleIdField === v.ruleIdField && s.target.quoteField === v.quoteField);
}

export const configHash = (cfg: SkillConfig) => createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 12);

const norm = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’`]+/g, ' ').trim();

/** Scores one output against a case. Pure function — unit-tested separately. */
export function scoreCase(output: unknown, c: EvalCase, target: EvalSet['target'], knownRules: Set<string>, material: string): Omit<EvalCaseResult, 'caseId' | 'title' | 'split' | 'tags' | 'ok' | 'usage' | 'latencyMs'> {
  const rows = collectPath(output, `${target.listPath}[]`)
    .map((x) => x.value)
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const matched = new Set<string>();
  const falsePositives: EvalCaseResult['falsePositives'] = [];
  const mustNotFlagHits: EvalCaseResult['mustNotFlagHits'] = [];
  let quotesVerified = 0;
  let unknownRules = 0;
  rows.forEach((row, index) => {
    const ruleId = String(row[target.ruleIdField] ?? '').trim();
    const quote = String(row[target.quoteField] ?? '');
    const q = norm(quote);
    if (quote && locate(quote, { text: material }).found) quotesVerified++;
    if (ruleId && ruleId.toUpperCase() !== 'N/A' && !knownRules.has(ruleId)) unknownRules++;
    const mnf = c.mustNotFlag.find((m) => (m.rules ? m.rules.includes(ruleId) : true) && (m.anchor ? q.includes(norm(m.anchor)) : !!m.rules));
    if (mnf) {
      mustNotFlagHits.push({ index, ruleId, reason: mnf.reason });
      falsePositives.push({ index, ruleId, quote: quote.slice(0, 200), reason: `不应标记：${mnf.reason}` });
      return;
    }
    const candidates = c.expected.filter((e) => e.rules.includes(ruleId) && e.anchors.some((a) => q.includes(norm(a)) || (q.length >= 6 && norm(a).includes(q))));
    if (!candidates.length) {
      falsePositives.push({ index, ruleId, quote: quote.slice(0, 200), reason: c.expected.some((e) => e.anchors.some((a) => q.includes(norm(a)))) ? '引文对应已知问题，但规则编号不在可接受范围' : '不对应任何已标注的问题' });
      return;
    }
    const target2 = candidates.find((e) => !matched.has(e.id)) ?? candidates[0];
    matched.add(target2.id);
  });
  return {
    findings: rows.length,
    expected: c.expected.length,
    matched: [...matched],
    missed: c.expected.filter((e) => !matched.has(e.id)).map((e) => ({ id: e.id, description: e.description, rules: e.rules })),
    falsePositives,
    mustNotFlagHits,
    quotesVerified,
    unknownRules,
  };
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : undefined);

export function aggregate(results: EvalCaseResult[], feedback?: FeedbackStats): EvalMetrics {
  const ok = results.filter((r) => r.ok);
  const expected = ok.reduce((n, r) => n + r.expected, 0);
  const matchedExpected = ok.reduce((n, r) => n + r.matched.length, 0);
  const findings = ok.reduce((n, r) => n + r.findings, 0);
  const correctFindings = ok.reduce((n, r) => n + (r.findings - r.falsePositives.length), 0);
  const recall = ratio(matchedExpected, expected);
  // No findings at all: precision is vacuously 1 (nothing wrong was claimed); recall then decides F2.
  const precision = findings > 0 ? correctFindings / findings : ok.length ? 1 : undefined;
  const f2 = recall !== undefined && precision !== undefined ? (recall + precision > 0 ? (5 * precision * recall) / (4 * precision + recall) : 0) : undefined;
  const quoteRate = ratio(
    ok.reduce((n, r) => n + r.quotesVerified, 0),
    findings,
  );
  const cost = results.reduce((n, r) => n + (r.usage?.costUsd ?? 0), 0);
  const hasCost = results.some((r) => r.usage?.costUsd !== undefined);
  const m: EvalMetrics = {
    cases: results.length,
    errors: results.length - ok.length,
    expected,
    matchedExpected,
    findings,
    correctFindings,
    recall,
    precision,
    f2,
    quoteRate,
    unknownRuleRate: ratio(
      ok.reduce((n, r) => n + r.unknownRules, 0),
      findings,
    ),
    mustNotFlag: ok.reduce((n, r) => n + r.mustNotFlagHits.length, 0),
    costUsd: hasCost ? cost : undefined,
    tokens: results.reduce((n, r) => n + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0), 0),
    avgLatencyMs: results.length ? Math.round(results.reduce((n, r) => n + r.latencyMs, 0) / results.length) : 0,
  };
  if (f2 !== undefined) m.score = 0.5 * f2 + 0.15 * (quoteRate ?? 1) + (feedback?.h !== undefined ? 0.25 * feedback.h : 0);
  return m;
}

export function metricsBySplit(cases: EvalCaseResult[], feedback?: FeedbackStats): EvalRun['metrics'] {
  const train = cases.filter((c) => c.split === 'train');
  const holdout = cases.filter((c) => c.split === 'holdout');
  return { all: aggregate(cases, feedback), train: train.length ? aggregate(train, feedback) : undefined, holdout: holdout.length ? aggregate(holdout, feedback) : undefined };
}

/** Rule packs as production would use them: approved version when there is one, otherwise the draft (flagged). */
export function packsForEval(rt: Runtime, org: Org, cfg: SkillConfig): { packs: PackForRun[]; snapshots: RulePackSnapshot[]; warnings: RunWarning[] } {
  const packs: PackForRun[] = [];
  const snapshots: RulePackSnapshot[] = [];
  const warnings: RunWarning[] = [];
  for (const id of cfg.rulePackIds) {
    const rp = rt.db.rulePacks.get(org.id, id);
    if (!rp) throw Errors.notFound('Skill 关联的规则包');
    const status = rulePackStatus(rp);
    if (rp.approved && rp.approvedVersion) {
      packs.push({ id, name: rp.name, label: `approved v${rp.approvedVersion}`, content: rp.approved });
      snapshots.push({ id, name: rp.name, version: rp.approvedVersion, status, approval: rp.approval });
    } else {
      packs.push({ id, name: rp.name, label: 'draft — not reviewed', content: rp.draft });
      snapshots.push({ id, name: rp.name, version: 'draft', status });
      warnings.push({ code: 'RULEPACK_UNREVIEWED', message: `规则包「${rp.name}」尚未批准，评测使用其草稿内容。` });
    }
  }
  return { packs, snapshots, warnings };
}

function caseInputs(cfg: SkillConfig, c: EvalCase): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const def of cfg.inputs) {
    const v = c.inputs[def.key];
    if (v !== undefined) inputs[def.key] = v;
    // Upstream results (e.g. extracted claims) are not part of the labelled case: say so explicitly.
    else if (def.required && def.type !== 'document') inputs[def.key] = '(not provided in this evaluation — work from the other inputs)';
  }
  return inputs;
}

export interface EvalParams {
  rt: Runtime;
  org: Org;
  user: User;
  skill: { id: string; name: string; config: SkillConfig };
  version: EvalRun['version'];
  split: EvalRun['split'];
  set: EvalSet;
  feedback?: FeedbackStats;
  optimizationId?: string;
  /** Persist progress after every case (UI polling). */
  onProgress?: (r: EvalRun) => void;
}

export function newEvalRun(p: EvalParams, snapshots: RulePackSnapshot[], warnings: RunWarning[], total: number): EvalRun {
  return {
    id: `evl_${randomUUID().slice(0, 8)}`,
    orgId: p.org.id,
    skillId: p.skill.id,
    skillName: p.skill.name,
    evalSetId: p.set.id,
    version: p.version,
    configHash: configHash(p.skill.config),
    split: p.split,
    status: 'running',
    provider: p.rt.provider.info,
    rulePacks: snapshots,
    startedBy: p.user.id,
    startedByName: p.user.name,
    createdAt: new Date().toISOString(),
    progress: { done: 0, total },
    cases: [],
    metrics: {},
    feedback: p.feedback,
    optimizationId: p.optimizationId,
    warnings: [
      ...(p.rt.provider.info.mode === 'mock' ? [{ code: 'MOCK_MODE', message: '模拟模式：结果由程序拼装，指标只用于验证评测流程，不代表模型质量。' }] : []),
      ...warnings,
    ],
  };
}

/** Runs the skill over the selected cases (bounded concurrency) and scores each one. */
export async function runEval(p: EvalParams, run?: EvalRun): Promise<EvalRun> {
  const cases = p.set.cases.filter((c) => p.split === 'all' || c.split === p.split);
  if (!cases.length) throw Errors.badRequest('评测集中没有所选划分的用例。');
  const { packs, snapshots, warnings } = packsForEval(p.rt, p.org, p.skill.config);
  const r = run ?? newEvalRun(p, snapshots, warnings, cases.length);
  const knownRules = new Set(packs.flatMap((x) => x.content.rules.map((rule) => rule.id)));
  const results: EvalCaseResult[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      const inputs = caseInputs(p.skill.config, c);
      const started = Date.now();
      const exec = await executeSkill({
        runtime: p.rt,
        org: p.org,
        skill: p.skill,
        inputs,
        documents: {} as Record<string, MaterialDocument>,
        rulePacks: packs,
        mode: 'test',
        channel: inputs[p.skill.config.verification?.channelInput ?? 'channel'] || undefined,
        // Evaluation never pauses for approval: tools that need approval ("ask") are unavailable, "deny" stays denied.
        canUseTool: (tool) => {
          const d = decide(p.user, p.org.policy, `tool:${tool}`);
          return d === 'ask' ? 'deny' : d;
        },
      });
      const base = { caseId: c.id, title: c.title, split: c.split, tags: c.tags, usage: exec.usage, latencyMs: Date.now() - started };
      if (!exec.ok) {
        results[i] = { ...base, ok: false, error: exec.error, findings: 0, expected: c.expected.length, matched: [], missed: c.expected.map((e) => ({ id: e.id, description: e.description, rules: e.rules })), falsePositives: [], mustNotFlagHits: [], quotesVerified: 0, unknownRules: 0 };
      } else {
        const material = paginate(c.inputs.material ?? Object.values(c.inputs).join('\n'))
          .map((x) => x.text)
          .join('\n');
        results[i] = { ...base, ok: true, ...scoreCase(exec.output, c, p.set.target, knownRules, material) };
      }
      r.cases = results.filter(Boolean);
      r.progress = { done: r.cases.length, total: cases.length };
      p.onProgress?.(r);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(p.rt.features.PARALLEL_NODES ? p.rt.cfg.workflowConcurrency : 1, cases.length) }, worker));
    r.cases = results;
    r.metrics = metricsBySplit(results, p.feedback);
    r.status = 'succeeded';
  } catch (err) {
    r.status = 'failed';
    r.error = toErrorInfo(err);
  }
  r.finishedAt = new Date().toISOString();
  p.onProgress?.(r);
  return r;
}

export function assertEvaluable(cfg: SkillConfig): EvalSet {
  const set = evalSetFor(cfg);
  if (!set) {
    throw new AppError('EVAL_NOT_APPLICABLE', '没有适用于该 Skill 的评测集。', {
      status: 400,
      hint: '评测集针对“问题清单”类输出（列表路径 findings、字段 rule_id / quote）。请在 Skill 的“结论核验”中配置相同的列表与字段，或在 testdata/eval/ 中添加新的评测集。',
    });
  }
  return set;
}

// ───────────────────────── report ─────────────────────────
const pct = (x?: number) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const num3 = (x?: number) => (x === undefined ? '—' : x.toFixed(3));

export function renderEvalMarkdown(r: EvalRun, set?: Pick<EvalSet, 'name' | 'description' | 'labelledBy'>): string {
  const L: string[] = [];
  const ver = r.version === 'draft' ? '草稿' : r.version === 'candidate' ? '优化候选' : `v${r.version}`;
  L.push(`# 评测报告：${r.skillName}（${ver}）`, '');
  if (r.provider.mode === 'mock') L.push('> ⚠️ 模拟模式：未调用真实模型，结果由程序根据材料拼装。以下指标只证明评测流程可运行，**不代表任何模型的质量**。', '');
  L.push(
    `- 评测编号：${r.id}；评测集：${set?.name ?? r.evalSetId}；划分：${r.split}`,
    `- 模型：${r.provider.name} / ${r.provider.model}（${r.provider.mode === 'mock' ? '模拟' : '真实'}）`,
    `- 配置指纹：${r.configHash}；规则包：${r.rulePacks.map((p) => `${p.name} ${p.version === 'draft' ? '草稿' : `v${p.version}`}`).join('、') || '无'}`,
    `- 时间：${r.createdAt} → ${r.finishedAt ?? '进行中'}；状态：${r.status}`,
  );
  if (set?.labelledBy) L.push(`- 标注：${set.labelledBy}`);
  for (const w of r.warnings) L.push(`- 提示：${w.message}`);
  L.push('', '## 指标', '', '| 划分 | 用例 | 错误 | 召回率 | 精确率 | F2 | 引文可核验率 | 未知规则率 | 不应标记命中 | 综合分* | tokens | 费用 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, label] of [['train', '训练'], ['holdout', '留出'], ['all', '全部']] as const) {
    const m = r.metrics[k];
    if (!m) continue;
    L.push(`| ${label} | ${m.cases} | ${m.errors} | ${pct(m.recall)}（${m.matchedExpected}/${m.expected}） | ${pct(m.precision)}（${m.correctFindings}/${m.findings}） | ${num3(m.f2)} | ${pct(m.quoteRate)} | ${pct(m.unknownRuleRate)} | ${m.mustNotFlag} | ${num3(m.score)} | ${m.tokens} | ${m.costUsd === undefined ? '—' : `US$${m.costUsd.toFixed(4)}`} |`);
  }
  L.push('', '\\* 综合分为指南 R(v) 中可计算的部分：0.5·F2 + 0.15·引文可核验率（有人工反馈时 + 0.25·H）。LLM 评审分 J、成本与长度惩罚未计入。', '');
  if (r.feedback) L.push(`人工反馈（该版本的运行）：采纳 ${r.feedback.accepted}、修改后采纳 ${r.feedback.edited}、驳回 ${r.feedback.rejected}、补充漏项 ${r.feedback.missed}，H = ${num3(r.feedback.h)}`, '');
  L.push('## 逐例结果', '', '| 用例 | 划分 | 发现 | 命中/期望 | 漏检 | 误报 | 不应标记 | 引文核验 | 状态 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of r.cases) {
    if (!c) continue;
    L.push(
      `| ${c.caseId} ${c.title} | ${c.split === 'train' ? '训练' : '留出'} | ${c.findings} | ${c.matched.length}/${c.expected} | ${c.missed.map((m) => m.id).join(', ') || '—'} | ${c.falsePositives.length} | ${c.mustNotFlagHits.length} | ${c.quotesVerified}/${c.findings} | ${c.ok ? '完成' : `错误：${c.error?.code}`} |`,
    );
  }
  const misses = r.cases.filter(Boolean).flatMap((c) => c.missed.map((m) => `- ${c.caseId} 漏检 ${m.id}：${m.description}（可接受规则 ${m.rules.join(' / ')}）`));
  const fps = r.cases.filter(Boolean).flatMap((c) => c.falsePositives.map((f) => `- ${c.caseId} #${f.index + 1} ${f.ruleId || '（无规则）'}：${f.reason}`));
  if (misses.length) L.push('', '## 漏检明细', '', ...misses);
  if (fps.length) L.push('', '## 误报明细', '', ...fps);
  return L.join('\n');
}
