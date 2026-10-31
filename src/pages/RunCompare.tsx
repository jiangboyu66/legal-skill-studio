import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collectPath } from '../../shared/schema';
import type { Run, RunSummary } from '../../shared/types';
import { api } from '../api';
import { Diff } from '../components/Diff';
import { ErrorNotice, fmtDuration, fmtTime, Loading, StatusBadge } from '../components/ui';
import { JurisdictionBadge } from './RunDetail';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

interface Item {
  key: string;
  ruleId: string;
  quote: string;
  text: string;
}

/** Findings of one node, keyed by rule ID + quote so two runs can be aligned. */
function itemsOf(run: Run, nodeId: string): Item[] | undefined {
  const n = run.nodes[nodeId];
  if (!n || n.status !== 'succeeded' || !n.output || typeof n.output !== 'object') return undefined;
  const v = n.skillId ? run.skills[n.skillId]?.config.verification : undefined;
  const listPath = v?.listPath ?? Object.entries(n.output as Record<string, unknown>).find(([, x]) => Array.isArray(x) && x.length && typeof x[0] === 'object')?.[0];
  if (!listPath) return undefined;
  return collectPath(n.output, `${listPath}[]`)
    .map((x) => x.value as Record<string, unknown>)
    .filter((x) => x && typeof x === 'object')
    .map((row) => {
      const ruleId = String(row[v?.ruleIdField ?? 'rule_id'] ?? '');
      const quote = String(row[v?.quoteField ?? 'quote'] ?? '');
      const text = String(row[v?.conclusionField ?? 'issue'] ?? JSON.stringify(row));
      return { key: `${ruleId}|${norm(quote).slice(0, 80)}`, ruleId, quote, text };
    });
}

function Side({ run }: { run: Run }) {
  const nodes = run.order.map((id) => run.nodes[id]);
  return (
    <div className="small">
      <div className="row wrap">
        <Link to={`/runs/${run.id}`}>{run.id}</Link>
        <StatusBadge status={run.status} />
        <JurisdictionBadge run={run} />
      </div>
      <div className="muted">
        工作流 {run.workflowVersion === 'draft' ? '草稿' : `v${run.workflowVersion}`} · {run.provider.name}/{run.provider.model}
        {run.provider.mode === 'mock' ? '（模拟）' : ''} · {fmtTime(run.createdAt)} · 用时 {fmtDuration(run.startedAt ?? run.createdAt, run.finishedAt)}
      </div>
      <div className="muted">
        Skill：{nodes.filter((n) => n.type === 'skill').map((n) => `${n.name} ${n.skillVersion === 'draft' ? '草稿' : `v${n.skillVersion}`}`).join('，')}
      </div>
      <div className="muted">
        规则包：{run.rulePacks.map((p) => `${p.name} ${p.version === 'draft' ? '草稿' : `v${p.version}`}`).join('，') || '—'} · token {(run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)}
        {run.usage.costUsd !== undefined ? ` · US$${run.usage.costUsd.toFixed(4)}` : ''}
      </div>
    </div>
  );
}

/** Compare two runs (e.g. v1 vs v2 of a skill, or a retry/re-run with its original): versions, findings, final output. */
export default function RunCompare() {
  const [params, setParams] = useSearchParams();
  const aId = params.get('a') ?? '';
  const bId = params.get('b') ?? '';
  const [a, setA] = useState<Run>();
  const [b, setB] = useState<Run>();
  const [others, setOthers] = useState<RunSummary[]>([]);
  const [error, setError] = useState<unknown>();
  const [nodeId, setNodeId] = useState('');

  useEffect(() => {
    if (aId) api.runs.get(aId).then(setA).catch(setError);
  }, [aId]);
  useEffect(() => {
    if (bId) api.runs.get(bId).then(setB).catch(setError);
    else setB(undefined);
  }, [bId]);
  useEffect(() => {
    if (a) api.runs.list(a.workflowId).then((l) => setOthers(l.filter((x) => x.id !== a.id))).catch(() => undefined);
  }, [a]);

  const common = useMemo(() => {
    if (!a || !b) return [];
    return a.order.filter((id) => b.nodes[id] && itemsOf(a, id) && itemsOf(b, id));
  }, [a, b]);
  useEffect(() => {
    if (!nodeId && common.length) setNodeId(common.find((id) => a?.nodes[id].verification) ?? common[0]);
  }, [common, nodeId, a]);

  if (error) return <ErrorNotice error={error} />;
  if (!a) return <Loading />;

  const ia = nodeId && b ? itemsOf(a, nodeId) ?? [] : [];
  const ib = nodeId && b ? itemsOf(b, nodeId) ?? [] : [];
  const keysB = new Set(ib.map((x) => x.key));
  const keysA = new Set(ia.map((x) => x.key));
  const both = ia.filter((x) => keysB.has(x.key));
  const onlyA = ia.filter((x) => !keysB.has(x.key));
  const onlyB = ib.filter((x) => !keysA.has(x.key));
  const md = (r: Run) => (typeof r.finalOutput === 'string' ? r.finalOutput : undefined);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>对比运行：{a.workflowName}</h1>
          <p className="small muted">按“规则编号 + 原文引文”对齐两次运行的问题清单，用于比较 Skill 新旧版本、重试或重新运行前后的差异。</p>
        </div>
      </div>
      <section className="panel">
        <div className="compare-grid">
          <div>
            <div className="out-key">A</div>
            <Side run={a} />
          </div>
          <div>
            <div className="out-key">B</div>
            {b ? (
              <Side run={b} />
            ) : (
              <div className="small muted">请选择要对比的运行。</div>
            )}
            <select value={bId} onChange={(e) => setParams({ a: aId, b: e.target.value })} style={{ marginTop: 6 }} data-testid="compare-select">
              <option value="">选择同一工作流的另一次运行…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} · {fmtTime(o.createdAt)} · {o.status}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {b && (
        <section className="panel" data-testid="compare-findings">
          <div className="row wrap" style={{ justifyContent: 'space-between' }}>
            <h2 className="section">问题清单对比</h2>
            {common.length > 1 && (
              <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                {common.map((id) => (
                  <option key={id} value={id}>
                    {a.nodes[id].name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {!common.length ? (
            <div className="muted small">两次运行没有可对齐的问题清单节点。</div>
          ) : (
            <>
              <p className="small">
                共同 {both.length} 条 · 仅 A {onlyA.length} 条 · 仅 B {onlyB.length} 条
              </p>
              <div className="compare-grid">
                <div>
                  <div className="out-key">仅 A</div>
                  {onlyA.map((x, i) => (
                    <div key={i} className="cmp-row only">
                      <strong>{x.ruleId}</strong> “{x.quote}” — {x.text}
                    </div>
                  ))}
                  {!onlyA.length && <div className="muted small">无</div>}
                </div>
                <div>
                  <div className="out-key">仅 B</div>
                  {onlyB.map((x, i) => (
                    <div key={i} className="cmp-row only">
                      <strong>{x.ruleId}</strong> “{x.quote}” — {x.text}
                    </div>
                  ))}
                  {!onlyB.length && <div className="muted small">无</div>}
                </div>
              </div>
              <details className="adv">
                <summary>共同的 {both.length} 条</summary>
                {both.map((x, i) => (
                  <div key={i} className="cmp-row">
                    <strong>{x.ruleId}</strong> “{x.quote}”
                  </div>
                ))}
              </details>
            </>
          )}
        </section>
      )}
      {b && md(a) !== undefined && md(b) !== undefined && (
        <section className="panel">
          <h2 className="section">最终文书差异（B → A）</h2>
          <Diff before={md(b)} after={md(a)!} same="两次运行的最终文书相同。" />
        </section>
      )}
    </>
  );
}
