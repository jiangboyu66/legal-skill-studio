import { randomUUID } from 'node:crypto';
import { addFeedback, feedbackStats } from '../../shared/feedback';
import type { EvalCaseResult, EvalRun, FeedbackStats, GateCheck, OptimizationRun, Org, Skill, SkillConfig, User } from '../../shared/types';
import { AppError, Errors, toErrorInfo } from '../errors';
import { OPTIMIZER } from './agents';
import { assertEvaluable, configHash, type EvalSet, newEvalRun, packsForEval, runEval } from './eval';
import { requirePermission } from './permissions';
import type { Runtime } from './runtime';
import { executeSkill } from './skills';

/** Gate for optimiser candidates (guide: holdout improvement ≥ 0.03, length ≤ +20 %, no new false positives). */
export const GATE = { minHoldoutGain: 0.03, maxLengthRatio: 1.2 };

export const OPTIMIZER_SKILL_NAME = '优化候选生成';

/** Reviewer feedback on runs that used `skillId` at `version` (published versions only). */
export function feedbackForSkill(rt: Runtime, orgId: string, skillId: string, version: number): FeedbackStats | undefined {
  let total: FeedbackStats | undefined;
  for (const run of rt.db.listRuns(orgId, { limit: 500 })) {
    if (run.skills[skillId]?.version !== version) continue;
    for (const n of Object.values(run.nodes)) {
      if (n.skillId !== skillId) continue;
      const s = feedbackStats(run, n.nodeId);
      total = total ? addFeedback(total, s) : s;
    }
  }
  return total && total.accepted + total.edited + total.rejected + total.missed > 0 ? total : undefined;
}

export function evidenceText(base: EvalRun, feedbackNotes: string[]): { text: string; counts: OptimizationRun['evidence'] } {
  // Training split only — the holdout split must stay unseen by the optimiser.
  const train = base.cases.filter((c) => c.split === 'train' && c.ok);
  const missed = train.flatMap((c) => c.missed.map((m) => `- [missed] ${m.description} (acceptable rules: ${m.rules.join(', ')})`));
  const fps = train.flatMap((c) => c.falsePositives.filter((f) => !c.mustNotFlagHits.some((h) => h.index === f.index)).map((f) => `- [false positive] cited ${f.ruleId || '(none)'} — ${f.reason}`));
  const mnf = train.flatMap((c) => c.mustNotFlagHits.map((h) => `- [must not flag] cited ${h.ruleId} — ${h.reason}`));
  const text = [
    '## Evaluation failures on the training split',
    ...(missed.length ? missed : ['- (no missed issues)']),
    ...fps,
    ...mnf,
    '',
    '## Reviewer feedback from runs (rejections, corrections, missed issues)',
    ...(feedbackNotes.length ? feedbackNotes : ['- (none)']),
  ].join('\n');
  return { text, counts: { missed: missed.length, falsePositives: fps.length, mustNotFlag: mnf.length, feedback: feedbackNotes.length } };
}

function reviewerNotes(rt: Runtime, orgId: string, skillId: string): string[] {
  const notes: string[] = [];
  for (const run of rt.db.listRuns(orgId, { limit: 200 })) {
    for (const [key, mark] of Object.entries(run.reviews)) {
      const nodeId = key.split('|')[0];
      if (run.nodes[nodeId]?.skillId !== skillId) continue;
      if (mark.decision === 'rejected') notes.push(`- [rejected] ${mark.note ?? '(no note)'}`);
      if (mark.decision === 'edited') notes.push(`- [corrected] fields ${Object.keys(mark.edits ?? {}).join(', ')}${mark.note ? ` — ${mark.note}` : ''}`);
    }
    for (const m of run.missed ?? []) if (run.nodes[m.nodeId]?.skillId === skillId) notes.push(`- [missed by AI, added by reviewer] ${m.ruleId}: ${m.issue}`);
    if (notes.length >= 30) break;
  }
  return notes.slice(0, 30);
}

export function gateFor(base: EvalRun, cand: EvalRun, baseLen: number, candLen: number): { passed: boolean; checks: GateCheck[] } {
  const bh = base.metrics.holdout?.score;
  const ch = cand.metrics.holdout?.score;
  const fmt = (x?: number) => (x === undefined ? '—' : x.toFixed(3));
  const checks: GateCheck[] = [
    {
      name: '留出集综合分提升 ≥ 0.03',
      passed: bh !== undefined && ch !== undefined && ch - bh >= GATE.minHoldoutGain,
      detail: `基线 ${fmt(bh)} → 候选 ${fmt(ch)}（Δ ${bh !== undefined && ch !== undefined ? (ch - bh >= 0 ? '+' : '') + (ch - bh).toFixed(3) : '—'}）`,
    },
    {
      name: '“不应标记”误报不增加',
      passed: (cand.metrics.all?.mustNotFlag ?? 0) <= (base.metrics.all?.mustNotFlag ?? 0),
      detail: `基线 ${base.metrics.all?.mustNotFlag ?? 0} → 候选 ${cand.metrics.all?.mustNotFlag ?? 0}`,
    },
    {
      name: '运行错误不增加',
      passed: (cand.metrics.all?.errors ?? 0) <= (base.metrics.all?.errors ?? 0),
      detail: `基线 ${base.metrics.all?.errors ?? 0} → 候选 ${cand.metrics.all?.errors ?? 0}`,
    },
    {
      name: '任务说明长度 ≤ 基线的 120%',
      passed: candLen <= baseLen * GATE.maxLengthRatio,
      detail: `${baseLen} → ${candLen} 字符（${baseLen ? Math.round((candLen / baseLen) * 100) : 0}%）`,
    },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

/**
 * Evaluation and optimisation jobs. Both run in the background and persist progress; the API returns
 * the record immediately and the UI polls it. The optimiser never publishes: a candidate that passes
 * the gate can be adopted into the skill draft by a builder, and then goes through normal publish review.
 */
export class EvalService {
  private pending = new Set<Promise<unknown>>();
  constructor(private rt: Runtime) {}

  private track<T>(p: Promise<T>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private configFor(skill: Skill, target: 'draft' | 'published'): { config: SkillConfig; version: number | 'draft' } {
    if (target === 'published') {
      if (!skill.published || !skill.publishedVersion) throw Errors.badRequest('该 Skill 还没有已发布版本。');
      return { config: skill.published, version: skill.publishedVersion };
    }
    return { config: skill.draft, version: 'draft' };
  }

  start(p: { org: Org; user: User; skill: Skill; target: 'draft' | 'published'; split: EvalRun['split'] }): EvalRun {
    const { config, version } = this.configFor(p.skill, p.target);
    const set = assertEvaluable(config);
    const feedback = typeof version === 'number' ? feedbackForSkill(this.rt, p.org.id, p.skill.id, version) : undefined;
    return this.launch({ org: p.org, user: p.user, skill: { id: p.skill.id, name: p.skill.name, config }, version, split: p.split, set, feedback });
  }

  private launch(p: { org: Org; user: User; skill: { id: string; name: string; config: SkillConfig }; version: EvalRun['version']; split: EvalRun['split']; set: EvalSet; feedback?: FeedbackStats; optimizationId?: string }): EvalRun {
    const params = { rt: this.rt, ...p, onProgress: (r: EvalRun) => this.rt.db.evals.put(r) };
    const { snapshots, warnings } = packsForEval(this.rt, p.org, p.skill.config);
    const total = p.set.cases.filter((c) => p.split === 'all' || c.split === p.split).length;
    const run = newEvalRun(params, snapshots, warnings, total);
    this.rt.db.evals.put(run);
    this.rt.audit(p.org.id, p.user, 'skill.eval', 'skill', p.skill.id, { eval: run.id, version: p.version, split: p.split });
    this.track(runEval(params, run));
    return run;
  }

  /** Starts an optimisation: candidate instructions from training failures → full evaluation → gate. */
  optimize(p: { org: Org; user: User; skill: Skill; baselineEvalId: string }): OptimizationRun {
    requirePermission(p.user, p.org, 'skill.edit');
    const base = this.rt.db.evals.get(p.org.id, p.baselineEvalId);
    if (!base || base.skillId !== p.skill.id) throw Errors.notFound('基线评测');
    if (base.status !== 'succeeded' || base.split !== 'all') throw Errors.badRequest('需要一次已完成的“全部（训练 + 留出）”评测作为基线。');
    if (base.version !== 'draft' || base.configHash !== configHash(p.skill.draft)) {
      throw Errors.conflict('基线评测与当前草稿不一致。', '请先对当前草稿运行一次完整评测，再生成优化候选。');
    }
    if (p.skill.status === 'in_review') throw Errors.conflict('该 Skill 正在审核中，草稿已锁定。');
    const set = assertEvaluable(p.skill.draft);
    const notes = reviewerNotes(this.rt, p.org.id, p.skill.id);
    const ev = evidenceText(base, notes);
    const opt: OptimizationRun = {
      id: `opt_${randomUUID().slice(0, 8)}`,
      orgId: p.org.id,
      skillId: p.skill.id,
      skillName: p.skill.name,
      status: 'running',
      provider: this.rt.provider.info,
      baseline: { evalId: base.id, configHash: base.configHash, instructions: p.skill.draft.instructions },
      evidence: ev.counts,
      startedBy: p.user.id,
      startedByName: p.user.name,
      createdAt: new Date().toISOString(),
    };
    this.rt.db.optimizations.put(opt);
    this.rt.audit(p.org.id, p.user, 'skill.optimize', 'skill', p.skill.id, { optimization: opt.id, baseline: base.id });
    this.track(this.runOptimization(p.org, p.user, p.skill, base, set, ev.text, opt));
    return opt;
  }

  private async runOptimization(org: Org, user: User, skill: Skill, base: EvalRun, set: EvalSet, evidence: string, opt: OptimizationRun) {
    const save = () => this.rt.db.optimizations.put(opt);
    try {
      const cfg = skill.draft;
      const ruleIds = packsForEval(this.rt, org, cfg).packs.flatMap((x) => x.content.rules.map((r) => `${r.id} ${r.title}${r.appliesTo?.channels?.length ? ` {channels: ${r.appliesTo.channels.join(', ')}}` : ''}`));
      const optimizerConfig: SkillConfig = {
        instructions: 'Propose revised task instructions for the skill described in the inputs, following the agent rules. Return the complete revised instructions (not a diff).',
        knowledge: '',
        rulePackIds: [],
        inputs: [
          { key: 'current_instructions', label: 'Current instructions', type: 'long_text', required: true },
          { key: 'output_contract', label: 'Output contract', type: 'long_text', required: true },
          { key: 'rule_ids', label: 'Rule IDs the skill may cite', type: 'long_text', required: false },
          { key: 'evidence', label: 'Evidence', type: 'long_text', required: true },
        ],
        output: {
          format: 'json',
          fields: [
            { key: 'instructions', label: '修订后的任务说明', type: 'string', required: true },
            { key: 'rationale', label: '修订理由', type: 'string', required: true },
            { key: 'changes', label: '修改要点', type: 'string_list', required: true },
          ],
        },
        checks: [],
        tools: [],
        maxTurns: 3,
        testCases: [],
      };
      const exec = await executeSkill({
        runtime: this.rt,
        org,
        skill: { id: `${skill.id}:optimizer`, name: OPTIMIZER_SKILL_NAME, config: optimizerConfig },
        inputs: {
          current_instructions: cfg.instructions,
          output_contract: JSON.stringify(cfg.output.fields, null, 2),
          rule_ids: ruleIds.join('\n'),
          evidence,
        },
        documents: {},
        rulePacks: [],
        mode: 'test',
        agent: OPTIMIZER,
        canUseTool: () => 'deny',
      });
      opt.usage = exec.usage;
      if (!exec.ok) throw new AppError(exec.error?.code ?? 'OPTIMIZER_FAILED', `优化候选生成失败：${exec.error?.message ?? ''}`, { hint: exec.error?.hint });
      const out = exec.output as { instructions?: string; rationale?: string; changes?: string[] };
      const instructions = String(out.instructions ?? '').trim();
      if (!instructions) throw new AppError('OPTIMIZER_EMPTY', '优化代理没有给出修订后的任务说明。');
      opt.candidate = { instructions, rationale: String(out.rationale ?? ''), changes: (out.changes ?? []).map(String) };
      save();

      const candidateConfig: SkillConfig = { ...cfg, instructions };
      const candRun = this.launch({ org, user, skill: { id: skill.id, name: skill.name, config: candidateConfig }, version: 'candidate', split: 'all', set, optimizationId: opt.id });
      opt.candidateEvalId = candRun.id;
      save();
      // launch() tracks the job; wait for it here so the gate sees final metrics.
      await this.waitFor(org.id, candRun.id);
      const cand = this.rt.db.evals.get(org.id, candRun.id)!;
      if (cand.status !== 'succeeded') throw new AppError('EVAL_FAILED', `候选版本评测失败：${cand.error?.message ?? ''}`);
      opt.gate = gateFor(base, cand, cfg.instructions.length, instructions.length);
      opt.status = 'succeeded';
    } catch (err) {
      opt.status = 'failed';
      opt.error = toErrorInfo(err);
    }
    opt.finishedAt = new Date().toISOString();
    save();
  }

  private async waitFor(orgId: string, evalId: string) {
    for (;;) {
      const r = this.rt.db.evals.get(orgId, evalId);
      if (!r || r.status !== 'running') return;
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }

  /** Human decision: copy a gated candidate into the skill draft (publishing still needs review). */
  adopt(p: { org: Org; user: User; skill: Skill; optimizationId: string }): Skill {
    requirePermission(p.user, p.org, 'skill.edit');
    const opt = this.rt.db.optimizations.get(p.org.id, p.optimizationId);
    if (!opt || opt.skillId !== p.skill.id) throw Errors.notFound('优化记录');
    if (opt.status !== 'succeeded' || !opt.candidate) throw Errors.conflict('该优化尚未完成或没有候选。');
    if (!opt.gate?.passed) throw Errors.conflict('候选未通过门控，不能采用。', '门控要求留出集综合分提升至少 0.03、误报与错误不增加、说明长度不超过 120%。');
    if (opt.adopted) throw Errors.conflict('该候选已被采用。');
    if (p.skill.status === 'in_review') throw Errors.conflict('该 Skill 正在审核中，草稿已锁定。');
    if (configHash(p.skill.draft) !== opt.baseline.configHash) throw Errors.conflict('草稿在生成候选后已被修改。', '请对当前草稿重新评测并生成候选。');
    const ts = new Date().toISOString();
    const next: Skill = { ...p.skill, draft: { ...p.skill.draft, instructions: opt.candidate.instructions }, updatedBy: p.user.id, updatedAt: ts };
    opt.adopted = { by: p.user.id, byName: p.user.name, at: ts };
    this.rt.db.tx(() => {
      this.rt.db.skills.put(next);
      this.rt.db.optimizations.put(opt);
    });
    this.rt.audit(p.org.id, p.user, 'skill.optimize_adopt', 'skill', p.skill.id, { optimization: opt.id });
    return next;
  }
}

export type { EvalCaseResult };
