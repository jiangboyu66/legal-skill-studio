import { useCallback, useEffect, useState } from 'react';
import type { EvalMetrics, EvalRun, OptimizationRun, SkillEvalsView, SkillView } from '../../shared/types';
import { api } from '../api';
import { Diff } from './Diff';
import { ErrorNotice, fmtTime, ModeBadge, useAuth, useToast } from './ui';

const pct = (x?: number) => (x === undefined ? '—' : `${(x * 100).toFixed(0)}%`);
const n3 = (x?: number) => (x === undefined ? '—' : x.toFixed(3));
const verLabel = (v: EvalRun['version']) => (v === 'draft' ? '草稿' : v === 'candidate' ? '优化候选' : `v${v}`);

/** Metric table for one evaluation (train / holdout / all). */
export function EvalMetricsTable({ run }: { run: EvalRun }) {
  const rows: [string, EvalMetrics | undefined][] = [
    ['训练', run.metrics.train],
    ['留出', run.metrics.holdout],
    ['全部', run.metrics.all],
  ];
  return (
    <div className="table-scroll">
      <table className="t small" data-testid="eval-metrics">
        <thead>
          <tr>
            <th>划分</th>
            <th title="命中的期望问题 / 期望问题">召回率</th>
            <th title="正确的发现 / 全部发现">精确率</th>
            <th title="召回加权的 F 值（漏检比误报代价更高）">F2</th>
            <th title="引文能在材料中找到的比例">引文核验</th>
            <th title="命中“不应标记”清单的发现数">不应标记</th>
            <th title="0.5·F2 + 0.15·引文核验（+0.25·H）">综合分</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter(([, m]) => m)
            .map(([label, m]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  {pct(m!.recall)} <span className="muted">({m!.matchedExpected}/{m!.expected})</span>
                </td>
                <td>
                  {pct(m!.precision)} <span className="muted">({m!.correctFindings}/{m!.findings})</span>
                </td>
                <td>{n3(m!.f2)}</td>
                <td>{pct(m!.quoteRate)}</td>
                <td className={m!.mustNotFlag ? 'text-bad' : ''}>{m!.mustNotFlag}</td>
                <td>
                  <strong>{n3(m!.score)}</strong>
                </td>
                <td>{m!.errors}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function CaseTable({ run }: { run: EvalRun }) {
  return (
    <div className="table-scroll">
      <table className="t small" data-testid="eval-cases">
        <thead>
          <tr>
            <th>用例</th>
            <th>划分</th>
            <th>命中/期望</th>
            <th>漏检</th>
            <th>误报</th>
            <th>引文</th>
          </tr>
        </thead>
        <tbody>
          {run.cases.filter(Boolean).map((c) => (
            <tr key={c.caseId}>
              <td>
                {c.caseId} {c.title}
                {!c.ok && <div className="text-bad">错误：{c.error?.message}</div>}
              </td>
              <td>{c.split === 'train' ? '训练' : '留出'}</td>
              <td>
                {c.matched.length}/{c.expected}
              </td>
              <td title={c.missed.map((m) => `${m.id} ${m.description}`).join('\n')}>{c.missed.length ? c.missed.map((m) => m.id.replace(`${c.caseId}-`, '#')).join(' ') : '—'}</td>
              <td title={c.falsePositives.map((f) => `${f.ruleId}: ${f.reason}`).join('\n')}>
                {c.falsePositives.length}
                {c.mustNotFlagHits.length ? <span className="text-bad">（{c.mustNotFlagHits.length} 条不应标记）</span> : null}
              </td>
              <td>
                {c.quotesVerified}/{c.findings}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Side-by-side holdout comparison of two evaluations (e.g. submitted draft vs published version). */
export function EvalCompare({ a, b, labelA, labelB }: { a?: EvalRun; b?: EvalRun; labelA: string; labelB: string }) {
  if (!a && !b) return <div className="muted small">还没有评测结果。可在 Skill 编辑页的“评测与受控优化”中运行。</div>;
  const keys: [keyof EvalMetrics, string, (x?: number) => string][] = [
    ['recall', '召回率', pct],
    ['precision', '精确率', pct],
    ['f2', 'F2', n3],
    ['quoteRate', '引文核验', pct],
    ['mustNotFlag', '不应标记', (x) => String(x ?? 0)],
    ['score', '综合分', n3],
  ];
  const ma = a?.metrics.holdout;
  const mb = b?.metrics.holdout;
  return (
    <div data-testid="eval-compare">
      {(a?.provider.mode === 'mock' || b?.provider.mode === 'mock') && <div className="notice warn small" style={{ marginBottom: 8 }}>包含模拟模式的评测：指标只验证流程，不代表模型质量。</div>}
      <table className="t small">
        <thead>
          <tr>
            <th>留出集指标</th>
            <th>
              {labelB}
              {b ? <span className="muted">（{verLabel(b.version)}，{fmtTime(b.createdAt)}）</span> : <span className="muted">（未评测）</span>}
            </th>
            <th>
              {labelA}
              {a ? <span className="muted">（{verLabel(a.version)}，{fmtTime(a.createdAt)}）</span> : <span className="muted">（未评测）</span>}
            </th>
            <th>变化</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(([k, label, f]) => {
            const vb = mb?.[k] as number | undefined;
            const va = ma?.[k] as number | undefined;
            const d = va !== undefined && vb !== undefined ? va - vb : undefined;
            const better = d === undefined ? '' : k === 'mustNotFlag' ? (d < 0 ? 'text-ok' : d > 0 ? 'text-bad' : '') : d > 0 ? 'text-ok' : d < 0 ? 'text-bad' : '';
            return (
              <tr key={k}>
                <td>{label}</td>
                <td>{f(vb)}</td>
                <td>{f(va)}</td>
                <td className={better}>{d === undefined ? '—' : `${d > 0 ? '+' : ''}${k === 'mustNotFlag' ? d : d.toFixed(3)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OptimizationView({ opt, skill, base, onAdopted }: { opt: OptimizationRun; skill: SkillView; base?: EvalRun; onAdopted: (s: SkillView) => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [cand, setCand] = useState<EvalRun>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (opt.candidateEvalId) api.evals.get(opt.candidateEvalId).then(setCand).catch(() => undefined);
  }, [opt.candidateEvalId, opt.status]);
  async function adopt() {
    setBusy(true);
    setError(undefined);
    try {
      const s = await api.skills.adopt(skill.id, opt.id);
      toast('已把候选说明写入草稿；发布仍需提交审核');
      onAdopted(s);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="opt" data-testid="optimization">
      <div className="row wrap small">
        <strong>优化候选</strong>
        <span className={`badge ${opt.status === 'running' ? 'run' : opt.status === 'failed' ? 'bad' : opt.gate?.passed ? 'ok' : 'warn'}`} data-testid="opt-status">
          {opt.status === 'running' ? '生成与评测中…' : opt.status === 'failed' ? '失败' : opt.gate?.passed ? '通过门控' : '未通过门控'}
        </span>
        <span className="muted">
          {opt.startedByName} · {fmtTime(opt.createdAt)} · 依据：训练集漏检 {opt.evidence.missed}、误报 {opt.evidence.falsePositives}、不应标记 {opt.evidence.mustNotFlag}、人工反馈 {opt.evidence.feedback} 条（留出集不提供给优化代理）
        </span>
      </div>
      <ErrorNotice error={opt.error} />
      {opt.candidate && (
        <>
          <p className="small" style={{ margin: '8px 0 4px' }}>
            <strong>理由：</strong>
            {opt.candidate.rationale}
          </p>
          <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {opt.candidate.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <details className="adv">
            <summary>任务说明的改动</summary>
            <Diff before={opt.baseline.instructions} after={opt.candidate.instructions} same="与基线相同。" />
          </details>
        </>
      )}
      {cand?.status === 'succeeded' && base && (
        <div style={{ marginTop: 8 }}>
          <EvalCompare a={cand} b={base} labelA="候选" labelB="基线（草稿）" />
        </div>
      )}
      {opt.gate && (
        <ul className="gate" data-testid="gate">
          {opt.gate.checks.map((c) => (
            <li key={c.name} className={c.passed ? 'text-ok' : 'text-bad'}>
              {c.passed ? '✓' : '✗'} {c.name}：{c.detail}
            </li>
          ))}
        </ul>
      )}
      {opt.adopted ? (
        <div className="notice ok small">
          已由 {opt.adopted.byName} 于 {fmtTime(opt.adopted.at)} 采用为草稿。发布仍需提交审核。
        </div>
      ) : (
        opt.status === 'succeeded' &&
        can('skill.edit') && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary sm" onClick={adopt} disabled={busy || !opt.gate?.passed} title={opt.gate?.passed ? '写入草稿，之后照常提交审核' : '未通过门控的候选不能采用'} data-testid="adopt-candidate">
              采用为草稿
            </button>
            {!opt.gate?.passed && <span className="small muted">未通过门控，不能采用。</span>}
          </div>
        )
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

/**
 * Evaluation and controlled self-optimisation for a skill: run the labelled eval set on the draft or
 * the published version, compare, and let the optimiser propose instructions that must pass a gate on
 * the holdout split and be adopted by a person (publishing still requires review).
 */
export default function EvalPanel({ skill, unsaved, onSkillChange }: { skill: SkillView; unsaved: boolean; onSkillChange: (s: SkillView) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [view, setView] = useState<SkillEvalsView>();
  const [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.skills
      .evals(skill.id)
      .then(setView)
      .catch(setError);
  }, [skill.id]);
  useEffect(load, [load, skill.updatedAt]);
  const running = !!view && (view.runs.some((r) => r.status === 'running') || view.optimizations.some((o) => o.status === 'running'));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [running, load]);

  if (error) return <ErrorNotice error={error} />;
  if (!view) return null;
  const done = view.runs.filter((r) => r.status === 'succeeded' && r.split === 'all');
  const latestDraft = done.find((r) => r.version === 'draft' && r.configHash === view.draftHash);
  const latestPublished = done.find((r) => r.version === skill.publishedVersion);
  const shown = view.runs.find((r) => r.id === selected) ?? view.runs.find((r) => r.version !== 'candidate');
  const opt = view.optimizations[0];
  const optBase = opt ? view.runs.find((r) => r.id === opt.baseline.evalId) : undefined;

  async function start(target: 'draft' | 'published') {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.skills.startEval(skill.id, target, 'all');
      setSelected(r.id);
      toast('评测已开始');
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function optimize() {
    if (!latestDraft) return;
    setBusy(true);
    try {
      await api.skills.optimize(skill.id, latestDraft.id);
      toast('已开始生成优化候选（完成后自动在留出集上评测）');
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" data-testid="eval-panel">
      <h2 className="section">评测与受控优化</h2>
      {view.notApplicable || !view.set ? (
        <p className="section-help">{view.notApplicable}</p>
      ) : (
        <>
          <p className="section-help">
            用标注好的虚构材料评测：{view.set.name}（训练 {view.set.counts.train} 例 / 留出 {view.set.counts.holdout} 例，共 {view.set.counts.expected} 个期望问题）。{view.set.labelledBy}。
          </p>
          <div className="row wrap">
            <button className="sm" onClick={() => start('draft')} disabled={busy || unsaved || running} title={unsaved ? '请先保存草稿' : undefined} data-testid="eval-draft">
              评测草稿
            </button>
            {skill.publishedVersion && (
              <button className="sm" onClick={() => start('published')} disabled={busy || running} data-testid="eval-published">
                评测已发布 v{skill.publishedVersion}
              </button>
            )}
            {can('skill.edit') && (
              <button
                className="sm"
                onClick={optimize}
                disabled={busy || running || !latestDraft || skill.status === 'in_review'}
                title={latestDraft ? '根据训练集失败与人工反馈生成候选说明，并在留出集上评测与门控' : '需要先对当前草稿完成一次评测'}
                data-testid="optimize"
              >
                生成优化候选
              </button>
            )}
            {unsaved && <span className="small muted">评测使用已保存的草稿</span>}
          </div>

          {(latestDraft || latestPublished) && (
            <div style={{ marginTop: 12 }}>
              <div className="out-key">草稿 vs 已发布（留出集）</div>
              <EvalCompare a={latestDraft} b={latestPublished} labelA="当前草稿" labelB={`已发布 v${skill.publishedVersion ?? '—'}`} />
            </div>
          )}

          {view.runs.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="out-key">评测记录</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {view.runs.slice(0, 8).map((r) => (
                  <button key={r.id} className={`sm ${shown?.id === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)} data-testid="eval-run">
                    {verLabel(r.version)} · {r.status === 'running' ? `${r.progress.done}/${r.progress.total}` : r.status === 'failed' ? '失败' : `F2 ${n3(r.metrics.holdout?.f2)}`}
                  </button>
                ))}
              </div>
            </div>
          )}
          {shown && (
            <div style={{ marginTop: 10 }} data-testid="eval-detail">
              <div className="row wrap small">
                <span className={`badge ${shown.status === 'succeeded' ? 'ok' : shown.status === 'failed' ? 'bad' : 'run'}`} data-testid="eval-status">
                  {shown.status === 'succeeded' ? '完成' : shown.status === 'failed' ? '失败' : `运行中 ${shown.progress.done}/${shown.progress.total}`}
                </span>
                <ModeBadge mode={shown.provider.mode} />
                <span className="muted">
                  {verLabel(shown.version)} · {shown.startedByName} · {fmtTime(shown.createdAt)} · 指纹 {shown.configHash}
                </span>
              </div>
              {shown.warnings.map((w) => (
                <div key={w.code} className="notice warn small" style={{ marginTop: 6 }}>
                  {w.message}
                </div>
              ))}
              <ErrorNotice error={shown.error} />
              {shown.status === 'succeeded' && (
                <>
                  <EvalMetricsTable run={shown} />
                  {shown.feedback && (
                    <p className="small muted">
                      人工反馈（该版本的运行）：采纳 {shown.feedback.accepted} · 修改后采纳 {shown.feedback.edited} · 驳回 {shown.feedback.rejected} · 补充漏项 {shown.feedback.missed} · H = {n3(shown.feedback.h)}
                    </p>
                  )}
                  <details className="adv">
                    <summary>逐例结果</summary>
                    <CaseTable run={shown} />
                  </details>
                </>
              )}
            </div>
          )}
          {opt && (
            <div style={{ marginTop: 14 }}>
              <OptimizationView opt={opt} skill={skill} base={optBase} onAdopted={(s) => (onSkillChange(s), load())} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
