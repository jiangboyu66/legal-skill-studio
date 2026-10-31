import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { feedbackStats } from '../../shared/feedback';
import { ROLE_LABEL } from '../../shared/schema';
import { runLog } from '../../shared/runlog';
import type { NodeRun, NodeStatus, ReviewDecision, Run } from '../../shared/types';
import { api, download } from '../api';
import DagGraph from '../components/DagGraph';
import OutputView, { GroundingSummary, type ReviewHandler, SecurityNotes, Transcript, VerificationSummary } from '../components/OutputView';
import { NodeTip, RunProcess, useReplay } from '../components/RunProcess';
import { statusesAt, useRunLive, useTicker } from '../components/runLive';
import { ErrorBoundary, ErrorNotice, fmtDate, fmtDuration, fmtTime, Loading, ModeBadge, RunModeBadge, STATUS_LABEL, StatusBadge, useAuth, useToast } from '../components/ui';

type NodeTab = 'output' | 'process' | 'inputs' | 'prompt' | 'raw';

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

/** Results of the nodes that finished, for a run that failed or was rejected before its final step. */
function PartialResults({ run, onOpen, reviewFor }: { run: Run; onOpen: (id: string) => void; reviewFor: (id: string) => ReviewHandler | undefined }) {
  const done = run.order.map((id) => run.nodes[id]).filter((n) => n.type === 'skill' && n.status === 'succeeded');
  const failed = run.order.map((id) => run.nodes[id]).find((n) => n.status === 'failed' || n.status === 'rejected');
  return (
    <div data-testid="partial-results">
      <div className="notice error small" style={{ marginBottom: 12 }}>
        {run.status === 'rejected' ? '运行在审批节点被驳回，没有最终结果。' : '运行没有完成，没有最终结果。'}
        {failed && (
          <>
            {' '}
            问题出在节点「
            <button type="button" className="linkish" onClick={() => onOpen(failed.nodeId)} data-testid="open-failed-node">
              {failed.name}
            </button>
            」{failed.error ? `：${failed.error.message}` : failed.approval?.comment ? `：${failed.approval.comment}` : ''}。
          </>
        )}
        {done.length > 0 ? ' 已完成节点的结果保留在下方，可继续查看与复核。' : ''}
      </div>
      {done.map((n, i) => (
        <details key={n.nodeId} className="adv partial" open={i === done.length - 1}>
          <summary>
            「{n.name}」的结果 <StatusBadge status={n.status} /> <GroundingSummary grounding={n.validation?.grounding} /> <VerificationSummary v={n.verification} />
          </summary>
          <SafeOutput node={n} run={run} onReview={reviewFor(n.nodeId)} />
        </details>
      ))}
    </div>
  );
}

/** OutputView inside an error boundary: if rendering fails, the raw result is shown instead of a blank page. */
function SafeOutput({ node, run, onReview, value, format }: { node?: NodeRun; run: Run; onReview?: ReviewHandler; value?: unknown; format?: 'markdown' | 'json' }) {
  const v = value !== undefined ? value : node?.output;
  return (
    <ErrorBoundary
      resetKey={JSON.stringify(v)?.length}
      fallback={(err) => (
        <div data-testid="render-fallback">
          <div className="notice warn small">结果的格式化显示出错（{err.message}），以下是原始结果：</div>
          <pre className="raw">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</pre>
        </div>
      )}
    >
      <OutputView value={v} format={format ?? node?.outputFormat ?? 'markdown'} fields={node?.outputFields} grounding={node?.validation?.grounding} verification={node?.verification} nodeId={node?.nodeId} reviews={run.reviews} onReview={onReview} />
    </ErrorBoundary>
  );
}

export default function RunDetail() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { me, can } = useAuth();
  const { run, error, refreshError, live, active, reload, setRun } = useRunLive(id);
  const [view, setView] = useState<string>('final');
  const [tab, setTab] = useState<NodeTab>('output');
  const [busy, setBusy] = useState(false);
  const [hoverNode, setHoverNode] = useState<string>();
  const log = useMemo(() => (run ? runLog(run) : []), [run]);
  const replay = useReplay(log, sp.get('replay') === '1' && !!run && !active);
  const resultsRef = useRef<HTMLDivElement>(null);
  useTicker(active);

  useEffect(() => {
    setView(sp.get('node') || 'final');
    setTab('output');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!run) return error ? <ErrorNotice error={error} /> : <Loading />;

  const nodes = run.order.map((n) => run.nodes[n]);
  const grounding = nodes.flatMap((n) => n.validation?.grounding ?? []);
  const gTotal = grounding.reduce((s, g) => s + g.total, 0);
  const gPassed = grounding.reduce((s, g) => s + g.passed, 0);
  const flagged = nodes.reduce((s, n) => s + (n.verification?.summary.flagged ?? 0), 0);
  const verified = nodes.reduce((s, n) => s + (n.verification?.items.length ?? 0), 0);
  const fb = feedbackStats(run);
  const reviewable = fb.accepted + fb.edited + fb.rejected + fb.pending;
  const waiting = nodes.filter((n) => n.status === 'waiting_approval' && n.approvalRequest);
  const canRerun = run.mode === 'production' ? can('workflow.run') : can('workflow.test');
  const replayAt = replay.on ? replay.current?.seq : undefined;
  const replayStatuses = replay.on && replayAt !== undefined ? statusesAt(run, log, replayAt) : undefined;
  const doneCount = nodes.filter((n) => (replayStatuses?.[n.nodeId] ?? n.status) === 'succeeded').length;

  async function rerun() {
    setBusy(true);
    try {
      const r = await api.runs.rerun(run!.id);
      toast('已使用当前配置重新运行');
      nav(`/runs/${r.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
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
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function exportAs(format: 'md' | 'json') {
    try {
      await download(api.runs.exportUrl(run!.id, format), `${run!.id}.${format}`);
    } catch (e) {
      toast((e as Error).message, 'error');
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
  const openNode = (nodeId: string) => {
    setView(nodeId);
    setTab('output');
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const info = Object.fromEntries(
    nodes.map((n) => {
      const st = replayStatuses?.[n.nodeId] ?? n.status;
      const sub =
        n.type === 'approval'
          ? n.approval && !replayStatuses
            ? `${n.approval.decision === 'approved' ? '已批准' : '已驳回'} · ${n.approval.byName}`
            : '人工审批'
          : st === 'running' && !replayStatuses && n.startedAt
            ? `运行中 · ${fmtDuration(n.startedAt, new Date().toISOString())}`
            : `${n.skillName ?? ''} ${n.skillVersion === 'draft' ? '草稿' : `v${n.skillVersion}`}`;
      return [n.nodeId, { status: st, sub }];
    }),
  );
  const outNode = (run.finalNodeId ? run.nodes[run.finalNodeId] : undefined) ?? nodes.find((n) => n.nodeId === run.definition.outputNodeId);
  const sel = view === 'final' ? undefined : run.nodes[view];
  if (view !== 'final' && !sel) setView('final');
  const highlight = replay.on ? replay.current?.nodeId : hoverNode;

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
              工作流 {run.workflowVersion === 'draft' ? '草稿' : `v${run.workflowVersion}`} · 发起人 {run.startedByName} · {fmtTime(run.createdAt)} · 用时{' '}
              <span data-testid="run-elapsed">{fmtDuration(run.startedAt ?? run.createdAt, run.finishedAt ?? (active ? new Date().toISOString() : undefined))}</span>
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
          <button className="btn" onClick={() => exportAs('md')} data-testid="export-md">
            导出报告
          </button>
          <button className="btn" onClick={() => exportAs('json')} data-testid="export-json">
            导出 JSON
          </button>
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

      {refreshError ? (
        <div className="notice warn small" style={{ marginBottom: 12 }} data-testid="refresh-error">
          刷新失败：{(refreshError as Error).message}。页面保留最后一次获取的状态，运行本身不受影响。{' '}
          <button className="sm" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}

      <div className="summary-bar" data-testid="run-summary">
        <span>
          {doneCount}/{nodes.length} 个节点完成
          {!replayStatuses && nodes.some((n) => n.status === 'skipped') ? `（${nodes.filter((n) => n.status === 'skipped').length} 个跳过）` : ''}
          {replayStatuses ? '（回放位置）' : ''}
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
        <ErrorBoundary key={n.nodeId} label={`审批「${n.name}」`} resetKey={run.log?.length}>
          <ApprovalPanel run={run} node={n} onDone={reload} me={me} can={can} />
        </ErrorBoundary>
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
        <DagGraph
          nodes={run.definition.nodes}
          info={info}
          selected={view === 'final' ? undefined : view}
          highlight={highlight}
          onSelect={openNode}
          tip={(nid) => <NodeTip run={run} nodeId={nid} log={log} status={replayStatuses?.[nid]} upto={replayAt} />}
          testId="run-dag"
        />
        <div className="field-help">鼠标移到节点上查看该节点的处理过程；点击节点查看完整结果。</div>
      </section>

      <ErrorBoundary label="运行过程" resetKey={log.length}>
        <RunProcess run={run} log={log} active={active} live={live} replay={replay} onPickNode={openNode} onHoverNode={setHoverNode} defaultOpen={active || sp.get('replay') === '1'} />
      </ErrorBoundary>

      <div className="tabs" style={{ marginTop: 18 }} ref={resultsRef}>
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
              <SafeOutput node={outNode} run={run} value={run.finalOutput} format={run.finalFormat ?? 'markdown'} onReview={outNode ? reviewFor(outNode.nodeId) : undefined} />
              <MissedPanel run={run} onChange={(r) => setRun(() => r)} canEdit={can('run.review')} />
            </>
          ) : run.status === 'failed' || run.status === 'rejected' ? (
            <PartialResults run={run} onOpen={openNode} reviewFor={reviewFor} />
          ) : (
            <div className="empty" data-testid="final-pending">
              {run.status === 'waiting_approval' ? '等待审批：审批通过后继续运行，完成后在这里显示最终结果。' : '运行中，完成后在这里显示最终结果。进度见上方“运行过程”。'}
            </div>
          )}
        </section>
      ) : sel ? (
        <ErrorBoundary label={`节点「${sel.name}」`} resetKey={sel.nodeId}>
          <NodePanel run={run} node={sel} tab={tab} setTab={setTab} onReview={reviewFor(sel.nodeId)} replayStatus={replayStatuses?.[sel.nodeId]} />
        </ErrorBoundary>
      ) : null}
    </>
  );
}

function ApprovalPanel({ run, node, onDone, me, can }: { run: Run; node: NodeRun; onDone: () => void; me: ReturnType<typeof useAuth>['me']; can: (a: string) => boolean }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const req = node.approvalRequest;
  if (!req) return null;
  const def = run.definition.nodes.find((n) => n.id === node.nodeId);
  const show = def?.type === 'approval' ? (def.showNodeIds ?? []).map((x) => run.nodes[x]).filter(Boolean) : [];
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

function NodePanel({ run, node, tab: requested, setTab, onReview, replayStatus }: { run: Run; node: NodeRun; tab: NodeTab; setTab: (t: NodeTab) => void; onReview?: ReviewHandler; replayStatus?: NodeStatus }) {
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
      {replayStatus && replayStatus !== node.status && (
        <div className="notice info small" data-testid="replay-node-note">
          回放位置：该节点此时为「{STATUS_LABEL[replayStatus]}」；下面显示的是它最终的记录。
        </div>
      )}
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
              <SafeOutput node={node} run={run} onReview={onReview} />
            ) : (
              <div className="muted small">{node.status === 'running' ? '运行中…（“AI 过程”页签实时显示该节点的每一步）' : '没有结果。'}</div>
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
