import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { feedbackStats } from '../../shared/feedback';
import { ROLE_LABEL } from '../../shared/schema';
import type { NodeRun, ReviewDecision, Run } from '../../shared/types';
import { api } from '../api';
import DagGraph from '../components/DagGraph';
import OutputView, { GroundingSummary, type ReviewHandler, SecurityNotes, Transcript, VerificationSummary } from '../components/OutputView';
import { ErrorNotice, fmtDate, fmtDuration, fmtTime, Loading, ModeBadge, RunModeBadge, StatusBadge, useAuth, useToast } from '../components/ui';

type NodeTab = 'output' | 'process' | 'inputs' | 'prompt' | 'raw';
const TERMINAL = ['succeeded', 'failed', 'rejected'];

export function JurisdictionBadge({ run }: { run: Pick<Run, 'jurisdiction'> }) {
  const j = run.jurisdiction;
  if (!j) return <span className="badge warn" data-testid="jurisdiction">适用法域：未确定</span>;
  return (
    <span className={`badge ${j.assumed ? 'warn' : ''}`} title={j.source} data-testid="jurisdiction">
      适用法域：{j.value}
      {j.assumed ? '（假设）' : ''}
    </span>
  );
}

/** "补充漏项": issues the AI missed, recorded by the reviewer (feedback for evaluation and the optimiser). */
function MissedPanel({ run, onChange, canEdit }: { run: Run; onChange: (r: Run) => void; canEdit: boolean }) {
  const nodes = run.order.map((id) => run.nodes[id]).filter((n) => n.type === 'skill' && n.status === 'succeeded' && n.outputFormat === 'json');
  const [nodeId, setNodeId] = useState(nodes.find((n) => n.verification)?.nodeId ?? nodes[0]?.nodeId ?? '');
  const [ruleId, setRuleId] = useState('');
  const [quote, setQuote] = useState('');
  const [issue, setIssue] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const rules = [...new Set(Object.values(run.rulePackContents).flatMap((c) => c.rules.map((r) => r.id)))];
  const missed = run.missed ?? [];
  if (!nodes.length && !missed.length) return null;
  async function add() {
    setError(undefined);
    try {
      const m = await api.runs.addMissed(run.id, { nodeId, ruleId, quote, issue });
      onChange({ ...run, missed: m });
      setRuleId('');
      setQuote('');
      setIssue('');
      setOpen(false);
    } catch (e) {
      setError(e);
    }
  }
  async function remove(id: string) {
    try {
      onChange({ ...run, missed: await api.runs.removeMissed(run.id, id) });
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div style={{ marginTop: 14 }} data-testid="missed-panel">
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <div className="out-key" style={{ margin: 0 }}>
          AI 漏掉的问题（{missed.length}）
        </div>
        {canEdit && nodes.length > 0 && (
          <button className="sm" onClick={() => setOpen((x) => !x)} data-testid="add-missed">
            补充漏项
          </button>
        )}
      </div>
      {missed.length > 0 && (
        <ul className="missed-list">
          {missed.map((m) => (
            <li key={m.id}>
              [{m.ruleId}] {m.issue}
              {m.quote ? <span className="muted">（原文：“{m.quote}”）</span> : null}
              <span className="small muted"> · {m.byName} · {run.nodes[m.nodeId]?.name}</span>
              {canEdit && (
                <button className="sm" style={{ marginLeft: 6 }} onClick={() => remove(m.id)}>
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="edit-form">
          <div className="cols-2">
            <label className="field">
              <span className="lbl">所属节点</span>
              <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} data-testid="missed-node">
                {nodes.map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">规则编号</span>
              <input type="text" list="missed-rules" value={ruleId} onChange={(e) => setRuleId(e.target.value)} placeholder="如 SCAP-04" aria-describedby="missed-rule-help" data-testid="missed-rule" />
              <div className="field-help" id="missed-rule-help">
                规则包没有覆盖的问题填 N/A。
              </div>
              <datalist id="missed-rules">
                {rules.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </label>
          </div>
          <label className="field">
            <span className="lbl">原文引文（可选）</span>
            <input type="text" value={quote} onChange={(e) => setQuote(e.target.value)} data-testid="missed-quote" />
          </label>
          <label className="field">
            <span className="lbl">漏掉的问题</span>
            <textarea rows={2} value={issue} onChange={(e) => setIssue(e.target.value)} data-testid="missed-issue" />
          </label>
          <button className="primary sm" onClick={add} disabled={!issue.trim() || !nodeId} data-testid="missed-save">
            记录漏项
          </button>
        </div>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

export default function RunDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<unknown>();
  const [view, setView] = useState<string>('final');
  const [tab, setTab] = useState<NodeTab>('output');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(() => {
    if (id) api.runs.get(id).then(setRun).catch(setError);
  }, [id]);
  useEffect(() => {
    setRun(null);
    setView('final');
    load();
  }, [load]);

  // Live updates over Server-Sent Events while the run is active (falls back to polling).
  const active = !!run && !TERMINAL.includes(run.status);
  useEffect(() => {
    if (!id || !active) return;
    let poll: ReturnType<typeof setInterval> | undefined;
    const es = new EventSource(api.runs.eventsUrl(id));
    const refresh = () => {
      clearTimeout(pending.current);
      pending.current = setTimeout(load, 150);
    };
    es.onopen = () => setLive(true);
    es.onmessage = refresh;
    es.onerror = () => {
      setLive(false);
      es.close();
      poll ??= setInterval(load, 1500);
    };
    return () => {
      es.close();
      if (poll) clearInterval(poll);
      setLive(false);
    };
  }, [id, active, load]);

  // Jump to the node that needs attention.
  useEffect(() => {
    if (!run || view !== 'final') return;
    const failed = run.order.find((n) => run.nodes[n].status === 'failed');
    if (run.status === 'failed' && failed) setView(failed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status]);

  if (error) return <ErrorNotice error={error} />;
  if (!run) return <Loading />;

  const nodes = run.order.map((n) => run.nodes[n]);
  const grounding = nodes.flatMap((n) => n.validation?.grounding ?? []);
  const gTotal = grounding.reduce((s, g) => s + g.total, 0);
  const gPassed = grounding.reduce((s, g) => s + g.passed, 0);
  const flagged = nodes.reduce((s, n) => s + (n.verification?.summary.flagged ?? 0), 0);
  const verified = nodes.reduce((s, n) => s + (n.verification?.items.length ?? 0), 0);
  const fb = feedbackStats(run);
  const reviewable = fb.accepted + fb.edited + fb.rejected + fb.pending;
  const waiting = nodes.filter((n) => n.status === 'waiting_approval');
  const canRerun = run.mode === 'production' ? can('workflow.run') : can('workflow.test');

  async function rerun() {
    setBusy(true);
    try {
      const r = await api.runs.rerun(run!.id);
      toast('已使用当前配置重新运行');
      nav(`/runs/${r.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      const r = await api.runs.retry(run!.id);
      toast('已从失败节点重试（复用已成功节点的结果）');
      nav(`/runs/${r.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function review(nodeId: string, location: string, decision: ReviewDecision | null, extra?: { edits?: Record<string, string>; note?: string }) {
    try {
      const reviews = await api.runs.review(run!.id, nodeId, location, decision, extra?.note, extra?.edits);
      setRun((r) => (r ? { ...r, reviews } : r));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  const reviewFor = (nodeId: string): ReviewHandler | undefined => (can('run.review') ? (loc, d, extra) => review(nodeId, loc, d, extra) : undefined);

  const info = Object.fromEntries(
    nodes.map((n) => [n.nodeId, { status: n.status, sub: n.type === 'approval' ? (n.approval ? `${n.approval.decision === 'approved' ? '已批准' : '已驳回'} · ${n.approval.byName}` : '人工审批') : `${n.skillName ?? ''} ${n.skillVersion === 'draft' ? '草稿' : `v${n.skillVersion}`}` }]),
  );
  const outNode = (run.finalNodeId ? run.nodes[run.finalNodeId] : undefined) ?? nodes.find((n) => n.nodeId === run.definition.outputNodeId);
  const sel = view === 'final' ? undefined : run.nodes[view];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>运行：{run.workflowName}</h1>
          <div className="row wrap small">
            <span data-testid="run-status" data-status={run.status}>
              <StatusBadge status={run.status} />
            </span>
            <RunModeBadge mode={run.mode} />
            <ModeBadge mode={run.provider.mode} />
            <JurisdictionBadge run={run} />
            <span className="muted">
              工作流 {run.workflowVersion === 'draft' ? '草稿' : `v${run.workflowVersion}`} · 发起人 {run.startedByName} · {fmtTime(run.createdAt)} · 用时 {fmtDuration(run.startedAt ?? run.createdAt, run.finishedAt ?? (active ? new Date().toISOString() : undefined))}
            </span>
            {active && <span className={`badge ${live ? 'run' : ''}`}>{live ? '实时更新中' : '自动刷新中'}</span>}
            {run.rerunOf && (
              <span className="muted">
                重新运行自 <Link to={`/runs/${run.rerunOf}`}>{run.rerunOf}</Link>
              </span>
            )}
            {run.retryOf && (
              <span className="muted" data-testid="retry-of">
                从失败节点重试自 <Link to={`/runs/${run.retryOf}`}>{run.retryOf}</Link>
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          <a className="btn" href={api.runs.exportUrl(run.id, 'md')} data-testid="export-md">
            导出报告
          </a>
          <a className="btn" href={api.runs.exportUrl(run.id, 'json')}>
            导出 JSON
          </a>
          <Link className="btn" to={`/runs/compare?a=${run.id}${run.retryOf || run.rerunOf ? `&b=${run.retryOf ?? run.rerunOf}` : ''}`} data-testid="compare-link">
            对比运行
          </Link>
          {canRerun && run.status === 'failed' && (
            <button className="primary" onClick={retry} disabled={busy || active} title="沿用原运行的版本与输入，复用已成功节点，只重跑失败及之后的节点" data-testid="retry">
              从失败节点重试
            </button>
          )}
          {canRerun && (
            <button className={run.status === 'failed' ? '' : 'primary'} onClick={rerun} disabled={busy || active} title="使用当前已发布（或草稿）配置，全部节点重新运行" data-testid="rerun">
              重新运行
            </button>
          )}
        </div>
      </div>

      <div className="summary-bar" data-testid="run-summary">
        <span>
          {nodes.filter((n) => n.status === 'succeeded').length}/{nodes.length} 个节点完成
          {nodes.some((n) => n.status === 'skipped') ? `（${nodes.filter((n) => n.status === 'skipped').length} 个跳过）` : ''}
        </span>
        {gTotal > 0 && <span className={`badge ${gPassed === gTotal ? 'ok' : 'bad'}`}>引文/编号核对 {gPassed}/{gTotal}</span>}
        {verified > 0 && (
          <span className={`badge ${flagged ? 'warn' : ''}`} title="核验只决定复核顺序；所有 AI 发现都需要人工确认后才能使用">
            结论核验：{flagged} 条优先复核 / 共 {verified} 条
          </span>
        )}
        {(reviewable > 0 || fb.missed > 0) && (
          <span className="small muted" data-testid="feedback-summary">
            人工复核：采纳 {fb.accepted} · 修改 {fb.edited} · 驳回 {fb.rejected} · 漏项 {fb.missed} · 待复核 {fb.pending}
            {fb.h !== undefined ? ` · H=${fb.h.toFixed(2)}` : ''}
          </span>
        )}
        {run.usage.inputTokens !== undefined && (
          <span className="small muted">
            token {run.usage.inputTokens?.toLocaleString()} / {run.usage.outputTokens?.toLocaleString()}
            {run.usage.cacheReadTokens ? `（缓存命中 ${run.usage.cacheReadTokens.toLocaleString()}）` : ''}
            {run.usage.costUsd !== undefined ? ` · 约 US$${run.usage.costUsd.toFixed(4)}` : ''}
          </span>
        )}
      </div>

      {run.warnings.length > 0 && (
        <div className="notice warn small" style={{ marginBottom: 12 }} data-testid="run-warnings">
          <ul style={{ margin: 0 }}>
            {run.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}
      {run.error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorNotice error={run.error} />
        </div>
      )}

      {waiting.map((n) => (
        <ApprovalPanel key={n.nodeId} run={run} node={n} onDone={load} me={me} can={can} />
      ))}

      <section className="panel">
        <div className="row wrap" style={{ justifyContent: 'space-between' }}>
          <h2 className="section">流程</h2>
          {run.rulePacks.length > 0 && (
            <div className="small" data-testid="run-rulepacks">
              规则包：
              {run.rulePacks.map((p) => (
                <span key={p.id} style={{ marginLeft: 6 }}>
                  {p.name}{' '}
                  {p.version === 'draft' ? (
                    <span className="badge warn">未经审核的草稿</span>
                  ) : (
                    <span className="badge ok" title={`${p.approval?.approverQualification}；复审截止 ${fmtDate(p.approval?.reviewDueAt)}`}>
                      v{p.version} · {p.approval?.approverName} 批准
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
        <DagGraph nodes={run.definition.nodes} info={info} selected={view === 'final' ? undefined : view} onSelect={(n) => (setView(n), setTab('output'))} testId="run-dag" />
      </section>

      <div className="tabs" style={{ marginTop: 18 }}>
        <button className={view === 'final' ? 'on' : ''} onClick={() => setView('final')} data-testid="view-final">
          最终结果
        </button>
        {nodes.map((n) => (
          <button key={n.nodeId} className={view === n.nodeId ? 'on' : ''} onClick={() => (setView(n.nodeId), setTab('output'))} data-testid={`view-${n.nodeId}`}>
            {n.name}
          </button>
        ))}
      </div>

      {view === 'final' ? (
        <section className="panel" data-testid="final-output">
          {run.finalOutput !== undefined ? (
            <>
              <p className="section-help">
                来自节点「{outNode?.name}」。<JurisdictionBadge run={run} /> 本结果由 AI 生成，仅为初审草稿，所有问题都须由具备资质的法律/合规人员复核后使用，不构成法律意见。
              </p>
              <SecurityNotes s={outNode?.security} />
              <OutputView value={run.finalOutput} format={run.finalFormat ?? 'markdown'} fields={outNode?.outputFields} grounding={outNode?.validation?.grounding} verification={outNode?.verification} nodeId={outNode?.nodeId} reviews={run.reviews} onReview={outNode ? reviewFor(outNode.nodeId) : undefined} />
              <MissedPanel run={run} onChange={setRun} canEdit={can('run.review')} />
            </>
          ) : (
            <div className="empty">
              {run.status === 'waiting_approval'
                ? '等待审批：审批通过后继续运行，完成后在这里显示最终结果。'
                : active
                  ? '运行中，完成后在这里显示最终结果…'
                  : run.status === 'rejected'
                    ? '运行在审批节点被驳回，没有最终结果。'
                    : '没有最终结果，请查看失败的节点。'}
            </div>
          )}
        </section>
      ) : sel ? (
        <NodePanel run={run} node={sel} tab={tab} setTab={setTab} onReview={reviewFor(sel.nodeId)} />
      ) : null}
    </>
  );
}

function ApprovalPanel({ run, node, onDone, me, can }: { run: Run; node: NodeRun; onDone: () => void; me: ReturnType<typeof useAuth>['me']; can: (a: string) => boolean }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const req = node.approvalRequest!;
  const def = run.definition.nodes.find((n) => n.id === node.nodeId);
  const show = def?.type === 'approval' ? def.showNodeIds.map((x) => run.nodes[x]).filter(Boolean) : [];
  let blocked = '';
  if (!can('run.approve_node')) blocked = '你的角色不能处理审批节点';
  else if (me.user.role !== 'admin' && me.user.role !== req.approverRole) blocked = `需要「${ROLE_LABEL[req.approverRole]}」角色`;
  else if (me.org.policy.requireDistinctApprover && run.startedBy === me.user.id) blocked = '四眼原则：不能审批自己发起的运行';

  async function decide(decision: 'approved' | 'rejected') {
    setBusy(true);
    setError(undefined);
    try {
      await api.runs.decide(run.id, node.nodeId, decision, comment);
      setComment('');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel approval" data-testid={`approval-${node.nodeId}`}>
      <h2 className="section">
        {req.tool ? `工具使用申请：${req.tool}` : `等待审批：${node.name}`} <span className="badge warn">需要「{ROLE_LABEL[req.approverRole]}」</span>
      </h2>
      <p style={{ marginTop: 4 }}>{req.instructions}</p>
      {req.reason && <p className="small muted">{req.reason}</p>}
      {show.map((n) => (
        <details key={n.nodeId} className="adv" open={show.length === 1}>
          <summary>
            查看「{n.name}」的结果 <StatusBadge status={n.status} /> <GroundingSummary grounding={n.validation?.grounding} /> <VerificationSummary v={n.verification} />
          </summary>
          {n.status === 'succeeded' ? <OutputView value={n.output} format={n.outputFormat ?? 'markdown'} fields={n.outputFields} grounding={n.validation?.grounding} verification={n.verification} /> : <div className="muted small">{n.skipReason ?? '无结果'}</div>}
        </details>
      ))}
      {blocked ? (
        <div className="notice info small" style={{ marginTop: 10 }}>
          {blocked}。审批人会在“审核与审批”中看到这项待办。
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <label className="field">
            <span className="lbl">审批意见（驳回时必填）</span>
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="approval-comment" />
          </label>
          <div className="row">
            <button className="primary" onClick={() => decide('approved')} disabled={busy} data-testid="approve-node">
              {req.tool ? '允许使用并继续' : '批准'}
            </button>
            <button className="danger" onClick={() => decide('rejected')} disabled={busy || !comment.trim()} data-testid="reject-node">
              驳回
            </button>
          </div>
        </div>
      )}
      <ErrorNotice error={error} />
    </section>
  );
}

function NodePanel({ run, node, tab: requested, setTab, onReview }: { run: Run; node: NodeRun; tab: NodeTab; setTab: (t: NodeTab) => void; onReview?: ReviewHandler }) {
  const { can } = useAuth();
  // Prompts and raw model output are authoring internals (the server does not send them to 使用者 either).
  const tabs: NodeTab[] = can('run.view_internals') ? ['output', 'process', 'inputs', 'prompt', 'raw'] : ['output', 'process', 'inputs'];
  const tab = tabs.includes(requested) ? requested : 'output';
  return (
    <section className="panel" data-testid={`node-panel-${node.nodeId}`}>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <strong>{node.name}</strong>
        <StatusBadge status={node.status} />
        {node.type === 'skill' && (
          <span className="small muted">
            Skill「{node.skillName}」{node.skillVersion === 'draft' ? '草稿' : `v${node.skillVersion}`} · {fmtDuration(node.startedAt, node.finishedAt, node.latencyMs)}
            {node.turns ? ` · ${node.turns} 轮` : ''}
            {node.attempts && node.attempts > 1 ? ` · 调用 ${node.attempts} 次` : ''}
            {node.usage?.inputTokens !== undefined ? ` · token ${node.usage.inputTokens}/${node.usage.outputTokens}` : ''}
          </span>
        )}
        {node.validation?.repaired && <span className="badge warn">已自动修正输出</span>}
        {node.reusedFrom && (
          <span className="badge" data-testid="reused">
            复用自 <Link to={`/runs/${node.reusedFrom}`}>{node.reusedFrom}</Link>
          </span>
        )}
        <GroundingSummary grounding={node.validation?.grounding} />
        <VerificationSummary v={node.verification} />
      </div>
      {node.skipReason && <div className="notice info small">已跳过：{node.skipReason}</div>}
      <SecurityNotes s={node.security} />
      {node.error && <ErrorNotice error={node.error} />}
      {node.approval && (
        <div className={`notice ${node.approval.decision === 'approved' ? 'ok' : 'error'} small`} data-testid="approval-record">
          {node.approval.decision === 'approved' ? '已批准' : '已驳回'} — {node.approval.byName}，{fmtTime(node.approval.at)}
          {node.approval.comment ? `；意见：${node.approval.comment}` : ''}
        </div>
      )}
      {node.type === 'skill' && (
        <>
          <div className="tabs">
            {tabs.map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} data-testid={`node-tab-${t}`}>
                {{ output: '结果', process: 'AI 过程', inputs: '实际输入', prompt: '提示词', raw: '原始返回' }[t]}
              </button>
            ))}
          </div>
          {tab === 'output' &&
            (node.status === 'succeeded' ? (
              <OutputView value={node.output} format={node.outputFormat ?? 'markdown'} fields={node.outputFields} grounding={node.validation?.grounding} verification={node.verification} nodeId={node.nodeId} reviews={run.reviews} onReview={onReview} />
            ) : (
              <div className="muted small">{node.status === 'running' ? '运行中…' : '没有结果。'}</div>
            ))}
          {tab === 'process' && <Transcript entries={node.transcript} />}
          {tab === 'inputs' &&
            (node.resolvedInputs ? (
              Object.entries(node.resolvedInputs).map(([k, v]) => (
                <div key={k}>
                  <div className="out-key">{k}</div>
                  <pre className="raw">{v || '（空）'}</pre>
                </div>
              ))
            ) : (
              <div className="muted small">尚未运行。</div>
            ))}
          {tab === 'prompt' &&
            (node.prompt ? (
              <>
                <div className="out-key">System（分层，含动态边界）</div>
                <pre className="raw">{node.prompt.system}</pre>
                <div className="out-key">User</div>
                <pre className="raw">{node.prompt.user}</pre>
              </>
            ) : (
              <div className="muted small">尚未运行。</div>
            ))}
          {tab === 'raw' && <pre className="raw">{node.rawOutput ?? '（无）'}</pre>}
        </>
      )}
    </section>
  );
}
