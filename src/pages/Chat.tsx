import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { runLog } from '../../shared/runlog';
import type { ChatMode, Conversation, ConversationMessage, ConversationSummary, DocumentSummary, NodeRun, Run, RunLogEntry, SampleMaterial, WorkflowView } from '../../shared/types';
import { api, download } from '../api';
import { OpenOriginal } from '../components/inputs';
import OutputView, { SafeMarkdown, SecurityNotes } from '../components/OutputView';
import { clock, NodeTip } from '../components/RunProcess';
import { useRunLive, useTicker } from '../components/runLive';
import { AutoTextarea, ErrorBoundary, ErrorNotice, fmtDuration, fmtTime, ModeBadge, STATUS_LABEL, StatusBadge, useAuth, useLoad, useToast } from '../components/ui';

const WF_KEY = 'lss.chat.workflow';
const DEMO_WF = 'wf_demo_sg_marketing_review';
const ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.md';

interface Draft {
  text: string;
  atts: DocumentSummary[];
  params: Record<string, string>;
}
const EMPTY: Draft = { text: '', atts: [], params: {} };

function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return iso.slice(5, 10).replace('-', '/');
}

function readPref(): string {
  try {
    return localStorage.getItem(WF_KEY) ?? '';
  } catch {
    return '';
  }
}
function writePref(id: string) {
  try {
    localStorage.setItem(WF_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * Chat home: send material (upload / paste / sample) → a workflow run starts and reports its progress in
 * the thread → the result stays in the conversation → ask follow-up questions about it. The left column
 * lists the user's conversations; the app's other areas stay in the main navigation.
 */
export default function Chat() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [listKey, setListKey] = useState(0);
  const listQ = useLoad(() => api.conversations.list(), [listKey]);
  const wfQ = useLoad(() => api.workflows.list(), []);
  const samplesQ = useLoad(() => api.samples(), []);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>();
  const [mode, setMode] = useState<ChatMode>('run');
  const [askRun, setAskRun] = useState<string>();
  const [wfId, setWfId] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [pending, setPending] = useState<{ text: string; at: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const canRun = can('workflow.run');

  const runnable = useMemo(() => (wfQ.data ?? []).filter((w) => w.publishedVersion && w.published), [wfQ.data]);
  const shown = conv && conv.id === id ? conv : null;

  // A conversation from the server never replaces a newer copy already on screen (e.g. the answer to a
  // send that arrived before a slower GET), so messages cannot vanish from the thread.
  const applyConv = useCallback((c: Conversation) => setConv((cur) => (cur && cur.id === c.id && Date.parse(cur.updatedAt) > Date.parse(c.updatedAt) ? cur : c)), []);
  const created = useRef<string>();

  // Load the selected conversation. A conversation this page just created is already on screen.
  useEffect(() => {
    if (id && created.current === id) {
      created.current = undefined;
      return;
    }
    setLoadErr(undefined);
    setMode('run');
    setAskRun(undefined);
    setDraft(EMPTY);
    if (!id) {
      setConv(null);
      return;
    }
    let alive = true;
    setConv((c) => (c?.id === id ? c : null));
    api.conversations
      .get(id)
      .then((c) => alive && applyConv(c))
      .catch((e) => alive && setLoadErr(e));
    return () => {
      alive = false;
    };
  }, [id, applyConv]);

  // Workflow for the next "review" message: the conversation's last one, else the user's last choice.
  useEffect(() => {
    if (!runnable.length) return;
    const pick = [shown?.workflowId, readPref(), DEMO_WF, runnable[0].id].find((x) => x && runnable.some((w) => w.id === x));
    setWfId(pick ?? runnable[0].id);
  }, [runnable, shown?.workflowId]);

  // After a reload while a follow-up was being answered, poll until the answer is stored.
  const lastMsg = shown?.messages[shown.messages.length - 1];
  const awaiting = !!lastMsg && lastMsg.role === 'user' && lastMsg.mode === 'ask' && Date.now() - Date.parse(lastMsg.at) < 180_000 && !pending;
  useEffect(() => {
    if (!awaiting || !shown) return;
    const t = setInterval(() => {
      api.conversations
        .get(shown.id)
        .then((c) => setConv((cur) => (cur?.id === c.id && Date.parse(c.updatedAt) >= Date.parse(cur.updatedAt) ? c : cur)))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [awaiting, shown]);

  const runIds = useMemo(() => (shown?.messages ?? []).flatMap((m) => (m.role === 'assistant' && m.kind === 'run' ? [m.runId] : [])), [shown]);
  const latestRun = runIds[runIds.length - 1];

  async function send(p: { mode: ChatMode; text: string; atts: DocumentSummary[]; params: Record<string, string>; rerunOf?: string }) {
    let c = shown;
    if (!c) {
      c = await api.conversations.create({ workflowId: wfId || undefined });
      created.current = c.id;
      setConv(c);
      nav(`/chat/${c.id}`);
      setListKey((k) => k + 1);
    }
    if (p.mode === 'ask') setPending({ text: p.text, at: new Date().toISOString() });
    try {
      const r = await api.conversations.send(c.id, {
        mode: p.mode,
        text: p.text,
        workflowId: wfId || undefined,
        attachments: p.atts.map((a) => ({ documentId: a.id })),
        inputs: p.params,
        runId: p.mode === 'ask' ? askRun ?? latestRun : undefined,
        rerunOf: p.rerunOf,
      });
      applyConv(r.conversation);
      setListKey((k) => k + 1);
      if (p.mode === 'run') writePref(wfId);
    } finally {
      setPending(null);
    }
  }

  const startAsk = useCallback((runId: string) => {
    setMode('ask');
    setAskRun(runId);
    setFocusTick((x) => x + 1);
  }, []);

  async function pickSample(s: SampleMaterial) {
    const params = Object.fromEntries(Object.entries(s.inputs).filter(([k]) => k !== 'material'));
    setMode('run');
    if (s.file) {
      const doc = await api.sampleDocument(s.id);
      setDraft({ text: '请审阅这份材料。', atts: [doc], params });
    } else setDraft({ text: s.inputs.material ?? '', atts: [], params });
    setFocusTick((x) => x + 1);
  }

  return (
    <div className="chat" data-testid="chat">
      <aside className="chat-list" aria-label="对话列表">
        <button className="primary chat-new" onClick={() => nav('/')} data-testid="chat-new">
          ＋ 新对话
        </button>
        <ConversationList items={listQ.data} activeId={id} />
      </aside>

      <section className="chat-main">
        {shown ? (
          <ChatHeader
            conv={shown}
            onRenamed={(c) => (setConv(c), setListKey((k) => k + 1))}
            onDeleted={() => {
              setListKey((k) => k + 1);
              nav('/');
            }}
          />
        ) : null}
        <Thread
          conv={shown}
          loading={!!id && !shown && !loadErr}
          error={loadErr}
          pending={pending}
          awaiting={awaiting}
          samples={samplesQ.data ?? []}
          onSample={pickSample}
          onAsk={startAsk}
          onRerun={(runId) => send({ mode: 'run', text: '', atts: [], params: {}, rerunOf: runId })}
          canRun={canRun}
          workflows={runnable}
          wfId={wfId}
        />
        <Composer
          convId={id}
          draft={draft}
          setDraft={setDraft}
          mode={mode}
          setMode={(m) => {
            setMode(m);
            if (m === 'ask' && !askRun) setAskRun(latestRun);
          }}
          workflows={runnable}
          wfLoading={wfQ.loading}
          wfId={wfId}
          setWfId={(x) => setWfId(x)}
          askRun={askRun ?? latestRun}
          canAsk={!!latestRun}
          canRun={canRun}
          onSend={send}
          focusTick={focusTick}
          busy={!!pending || awaiting}
        />
      </section>
    </div>
  );
}

function ConversationList({ items, activeId }: { items?: ConversationSummary[]; activeId?: string }) {
  if (!items) return <div className="muted small chat-list-empty">加载中…</div>;
  if (!items.length) return <div className="muted small chat-list-empty">还没有对话。发送第一份材料后，对话会保存在这里。</div>;
  return (
    <nav className="chat-items" data-testid="chat-list">
      {items.map((c) => (
        <Link key={c.id} to={`/chat/${c.id}`} className={`chat-item ${c.id === activeId ? 'on' : ''}`} data-testid={`chat-item-${c.id}`}>
          <span className="ci-title">{c.title}</span>
          <span className="ci-meta">
            {ago(c.updatedAt)}
            {c.runIds.length ? ` · ${c.runIds.length} 次审阅` : ''}
          </span>
          {c.lastText && <span className="ci-last">{c.lastText}</span>}
        </Link>
      ))}
    </nav>
  );
}

function ChatHeader({ conv, onRenamed, onDeleted }: { conv: Conversation; onRenamed: (c: Conversation) => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conv.title);
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  useEffect(() => {
    setTitle(conv.title);
    setEditing(false);
    setConfirm(false);
  }, [conv.id, conv.title]);
  async function save() {
    try {
      onRenamed(await api.conversations.update(conv.id, { title }));
      setEditing(false);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  async function remove() {
    try {
      await api.conversations.remove(conv.id);
      toast('对话已删除（运行记录仍保留在“运行记录”中）');
      onDeleted();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  return (
    <header className="chat-head">
      {editing ? (
        <form
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} aria-label="对话标题" autoFocus data-testid="chat-title-input" />
          <button className="sm primary" type="submit" disabled={!title.trim()}>
            保存
          </button>
          <button className="sm" type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      ) : (
        <h1 className="chat-title" data-testid="chat-title">
          {conv.title}
        </h1>
      )}
      {!editing && (
        <div className="row" style={{ gap: 4 }}>
          <button className="sm ghost" onClick={() => setEditing(true)} data-testid="chat-rename">
            重命名
          </button>
          {confirm ? (
            <>
              <button className="sm danger" onClick={remove} data-testid="chat-delete-confirm">
                确认删除
              </button>
              <button className="sm ghost" onClick={() => setConfirm(false)}>
                取消
              </button>
            </>
          ) : (
            <button className="sm ghost" onClick={() => setConfirm(true)} data-testid="chat-delete">
              删除
            </button>
          )}
        </div>
      )}
    </header>
  );
}

function Thread({
  conv,
  loading,
  error,
  pending,
  awaiting,
  samples,
  onSample,
  onAsk,
  onRerun,
  canRun,
  workflows,
  wfId,
}: {
  conv: Conversation | null;
  loading: boolean;
  error: unknown;
  pending: { text: string; at: string } | null;
  awaiting: boolean;
  samples: SampleMaterial[];
  onSample: (s: SampleMaterial) => Promise<void>;
  onAsk: (runId: string) => void;
  onRerun: (runId: string) => Promise<void>;
  canRun: boolean;
  workflows: WorkflowView[];
  wfId: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const count = (conv?.messages.length ?? 0) + (pending ? 1 : 0);

  // Stay pinned to the newest message while content grows (live progress), unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count, conv?.id]);
  useEffect(() => {
    const el = scroller.current;
    const body = inner.current;
    if (!el || !body || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    stick.current = true;
  }, [conv?.id]);

  const empty = !conv || conv.messages.length === 0;
  return (
    <div
      className="chat-scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      data-testid="chat-thread"
    >
      <div className="chat-inner" ref={inner}>
        {error ? <ErrorNotice error={error} /> : null}
        {loading ? <div className="muted small">加载对话…</div> : null}
        {empty && !loading && !error && <Welcome samples={samples} onSample={onSample} canRun={canRun} workflows={workflows} wfId={wfId} hasPending={!!pending} />}
        {conv?.messages.map((m) => <Message key={m.id} m={m} onAsk={onAsk} onRerun={onRerun} canRun={canRun} latestRunId={lastRunId(conv)} />)}
        {pending && (
          <>
            <div className="msg user" data-testid="chat-user-msg">
              <span className="tag">追问</span>
              <div className="msg-text">{pending.text}</div>
            </div>
            <Typing since={pending.at} />
          </>
        )}
        {awaiting && !pending && <Typing since={conv!.messages[conv!.messages.length - 1].at} />}
      </div>
    </div>
  );
}

const lastRunId = (c: Conversation) => {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.role === 'assistant' && m.kind === 'run') return m.runId;
  }
  return undefined;
};

function Typing({ since }: { since: string }) {
  useTicker(true);
  return (
    <div className="msg assistant typing" data-testid="chat-typing">
      <span className="dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      正在根据运行结果回答…（{fmtDuration(since, new Date().toISOString())}）
    </div>
  );
}

function Welcome({ samples, onSample, canRun, workflows, wfId, hasPending }: { samples: SampleMaterial[]; onSample: (s: SampleMaterial) => Promise<void>; canRun: boolean; workflows: WorkflowView[]; wfId: string; hasPending: boolean }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>();
  if (hasPending) return null;
  const wf = workflows.find((w) => w.id === wfId);
  return (
    <div className="chat-welcome" data-testid="chat-welcome">
      <h1>有什么材料需要审阅？</h1>
      <p>
        上传营销物料（PDF / Word / 图片）或直接粘贴文字，发送后系统按工作流{wf ? `「${wf.name}」` : ''}逐步执行，处理过程实时显示在对话里；完成后可以继续追问结果。
      </p>
      {canRun && samples.length > 0 && (
        <div className="samples" data-testid="chat-samples">
          <span className="small muted">试试示例材料（均为虚构）：</span>
          {samples.map((s) => (
            <button
              key={s.id}
              type="button"
              className="sm"
              title={s.description}
              disabled={!!busy}
              data-testid={`chat-sample-${s.id}`}
              onClick={() => {
                setBusy(s.id);
                setError(undefined);
                onSample(s)
                  .catch(setError)
                  .finally(() => setBusy(''));
              }}
            >
              {busy === s.id ? '解析中…' : s.title}
            </button>
          ))}
        </div>
      )}
      <ErrorNotice error={error} />
      <ul className="chat-tips">
        <li>AI 结果只是初审草稿，所有问题都须由具备资质的法律/合规人员复核后使用。</li>
        <li>每次审阅都是一条完整的运行记录：可在“运行记录”中查看、导出，并回放处理过程。</li>
        <li>需要人工审批的节点会出现在审核人的“审核与审批”中，批准后自动继续。</li>
      </ul>
    </div>
  );
}

function Message({ m, onAsk, onRerun, canRun, latestRunId }: { m: ConversationMessage; onAsk: (runId: string) => void; onRerun: (runId: string) => Promise<void>; canRun: boolean; latestRunId?: string }) {
  if (m.role === 'user') {
    return (
      <div className="msg user" data-testid="chat-user-msg">
        {m.mode === 'ask' ? <span className="tag">追问</span> : m.workflowName ? <span className="tag">{m.workflowName}</span> : null}
        {m.attachments?.map((a) => (
          <div key={a.documentId} className="att" data-testid="chat-attachment">
            <span>📄 {a.filename}</span>
            <span className="small muted">{a.pageCount ? `${a.pageCount} 页` : ''}</span>
            {a.kind && a.kind !== 'text' && <OpenOriginal id={a.documentId} label="原件" />}
          </div>
        ))}
        {m.text && <LongText text={m.text} />}
        <div className="msg-meta">{fmtTime(m.at)}</div>
      </div>
    );
  }
  if (m.kind === 'run') {
    return (
      <ErrorBoundary label="运行卡片" resetKey={m.runId}>
        <RunCard runId={m.runId} onAsk={onAsk} onRerun={onRerun} canRerun={canRun} latest={m.runId === latestRunId} />
      </ErrorBoundary>
    );
  }
  if (m.kind === 'answer') {
    return (
      <div className="msg assistant answer" data-testid="chat-answer">
        {m.provider.mode === 'mock' && <span className="badge mock">模拟回答</span>}
        <ErrorBoundary label="回答" resetKey={m.id}>
          <div className="doc">
            <SafeMarkdown>{m.text}</SafeMarkdown>
          </div>
        </ErrorBoundary>
        <SecurityNotes s={m.security} />
        <div className="msg-meta">
          依据运行 <Link to={`/runs/${m.runId}`}>{m.runId}</Link> · {m.provider.model}
          {m.latencyMs !== undefined ? ` · ${(m.latencyMs / 1000).toFixed(1)} s` : ''} · {fmtTime(m.at)} · AI 生成，仅供参考，不构成法律意见
        </div>
      </div>
    );
  }
  return (
    <div className="msg assistant" data-testid="chat-error">
      <ErrorNotice error={{ message: m.text, hint: m.hint, code: m.code }} />
    </div>
  );
}

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split('\n').length > 8;
  return (
    <>
      <div className={`msg-text ${long && !open ? 'clamp' : ''}`}>{text}</div>
      {long && (
        <button type="button" className="linkish more-btn small" onClick={() => setOpen((x) => !x)}>
          {open ? '收起' : '展开全文'}
        </button>
      )}
    </>
  );
}

// ───────────────────────── run card ─────────────────────────
function headline(run: Run, out?: NodeRun): string {
  const parts: string[] = [];
  const v = run.finalOutput;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const list = Object.entries(v as Record<string, unknown>).filter(([, x]) => Array.isArray(x)).sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length)[0];
    if (list) parts.push(`${out?.outputFields?.find((f) => f.key === list[0])?.label ?? list[0]} ${(list[1] as unknown[]).length} 项`);
  }
  const g = Object.values(run.nodes).flatMap((n) => n.validation?.grounding ?? []).filter((x) => !x.note);
  const total = g.reduce((s, x) => s + x.total, 0);
  if (total) parts.push(`引文/编号核对 ${g.reduce((s, x) => s + x.passed, 0)}/${total}`);
  const flagged = Object.values(run.nodes).reduce((s, n) => s + (n.verification?.summary.flagged ?? 0), 0);
  const verified = Object.values(run.nodes).reduce((s, n) => s + (n.verification?.items.length ?? 0), 0);
  if (verified) parts.push(`结论核验 ${flagged} 条优先复核 / 共 ${verified} 条`);
  return parts.join(' · ');
}

function LogLines({ log, t0, testId }: { log: RunLogEntry[]; t0: number; testId?: string }) {
  return (
    <ol className="chat-log" data-testid={testId}>
      {log.map((e) => (
        <li key={e.seq} className={`k-${e.kind}`}>
          <span className="t">
            {e.approx ? '≈' : ''}
            {clock(e.at)}
            <span className="rel">+{((Date.parse(e.at) - t0) / 1000).toFixed(1)}s</span>
          </span>
          <span className="x">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

function NodeChips({ run, log }: { run: Run; log: RunLogEntry[] }) {
  const [tip, setTip] = useState<{ id: string; x: number; y: number; above: boolean } | null>(null);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [tip]);
  const show = (nid: string, el: Element) => {
    const r = el.getBoundingClientRect();
    const above = r.bottom + 280 > window.innerHeight && r.top > 280;
    setTip({ id: nid, x: Math.max(8, Math.min(r.left, window.innerWidth - 348)), y: above ? r.top - 6 : r.bottom + 6, above });
  };
  return (
    <div className="rc-nodes" data-testid="chat-run-nodes">
      {run.order.map((nid, i) => {
        const n = run.nodes[nid];
        return (
          <span key={nid} className="rc-node-wrap">
            {i > 0 && <span className="rc-sep">›</span>}
            <span
              className={`rc-node s-${n.status}`}
              tabIndex={0}
              data-testid={`chat-node-${nid}`}
              data-status={n.status}
              onMouseEnter={(e) => show(nid, e.currentTarget)}
              onMouseLeave={() => setTip(null)}
              onFocus={(e) => show(nid, e.currentTarget)}
              onBlur={() => setTip(null)}
              aria-label={`${n.name}：${STATUS_LABEL[n.status]}`}
            >
              <span className="sdot" aria-hidden />
              {n.name}
            </span>
          </span>
        );
      })}
      {tip && (
        <div className="dag-tip" role="tooltip" data-testid="chat-node-tip" style={{ left: tip.x, width: 340, ...(tip.above ? { bottom: window.innerHeight - tip.y } : { top: tip.y }) }}>
          <NodeTip run={run} nodeId={tip.id} log={log} />
        </div>
      )}
    </div>
  );
}

function RunCard({ runId, onAsk, onRerun, canRerun, latest }: { runId: string; onAsk: (runId: string) => void; onRerun: (runId: string) => Promise<void>; canRerun: boolean; latest: boolean }) {
  const { run, error, refreshError, live, active } = useRunLive(runId);
  const toast = useToast();
  const { me } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  useTicker(active);
  const log = useMemo(() => (run ? runLog(run) : []), [run]);

  useLayoutEffect(() => {
    const el = resultRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollHeight > el.clientHeight + 4);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [run?.status, run?.finalOutput]);

  if (!run) {
    return (
      <div className="run-card" data-testid="chat-run-card">
        {error ? <ErrorNotice error={error} title={`无法加载运行 ${runId}`} /> : <span className="muted small">正在加载运行 {runId}…</span>}
      </div>
    );
  }
  const nodes = run.order.map((nid) => run.nodes[nid]);
  const finished = nodes.filter((n) => ['succeeded', 'skipped', 'failed', 'rejected'].includes(n.status)).length;
  const pct = Math.round((finished / Math.max(1, nodes.length)) * 100);
  const outNode = run.finalNodeId ? run.nodes[run.finalNodeId] : undefined;
  const waitingNode = nodes.find((n) => n.status === 'waiting_approval');
  const runningNodes = nodes.filter((n) => n.status === 'running');
  const t0 = Date.parse(run.createdAt);
  const terminal = !active;
  const done = nodes.filter((n) => n.type === 'skill' && n.status === 'succeeded');
  const head = run.status === 'succeeded' ? headline(run, outNode) : '';

  async function rerun() {
    setBusy(true);
    try {
      await onRerun(run!.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`run-card st-${run.status}`} data-testid="chat-run-card" data-run-id={run.id} data-status={run.status}>
      <div className="rc-head">
        <strong>{run.workflowName}</strong>
        <StatusBadge status={run.status} />
        <ModeBadge mode={run.provider.mode} />
        <span className="small muted">
          用时 {fmtDuration(run.startedAt ?? run.createdAt, run.finishedAt ?? new Date().toISOString())}
          {active ? (live ? ' · 实时' : ' · 自动刷新') : ''}
        </span>
        <span className="grow" />
        <Link className="small" to={`/runs/${run.id}`} data-testid="chat-run-link">
          {run.id}
        </Link>
      </div>

      <div className="rc-progress" aria-label={`进度 ${pct}%`}>
        <span style={{ width: `${pct}%` }} className={run.status === 'failed' || run.status === 'rejected' ? 'bad' : run.status === 'succeeded' ? 'ok' : ''} />
      </div>
      <NodeChips run={run} log={log} />

      {refreshError ? <div className="small text-bad">刷新失败：{(refreshError as Error).message}（显示最后一次获取的状态）</div> : null}

      {active && (
        <div className="rc-live" data-testid="chat-run-live">
          <div className="small muted">
            {waitingNode ? `暂停：等待审批「${waitingNode.name}」` : runningNodes.length ? `正在执行：${runningNodes.map((n) => `「${n.name}」`).join('、')}` : '排队中…'}
          </div>
          <LogLines log={showAll ? log : log.slice(-6)} t0={t0} testId="chat-run-log" />
          {log.length > 6 && (
            <button type="button" className="linkish small" onClick={() => setShowAll((x) => !x)}>
              {showAll ? '只看最新' : `查看全部 ${log.length} 条`}
            </button>
          )}
        </div>
      )}

      {waitingNode && (
        <div className="notice warn small" data-testid="chat-run-waiting">
          {waitingNode.approvalRequest?.tool ? `AI 请求使用工具「${waitingNode.approvalRequest.tool}」，` : ''}需要「{waitingNode.approvalRequest ? { admin: '管理员', builder: '构建者', reviewer: '法律审核人', runner: '使用者' }[waitingNode.approvalRequest.approverRole] : '审核人'}」批准后继续。
          {me.user.role === 'admin' || me.user.role === waitingNode.approvalRequest?.approverRole ? (
            <>
              {' '}
              <Link to={`/runs/${run.id}`}>去审批</Link>
            </>
          ) : (
            ' 审核人会在“审核与审批”中看到这项待办；批准后这里会自动继续。'
          )}
        </div>
      )}

      {run.status === 'succeeded' && run.finalOutput !== undefined && (
        <div className="rc-result-wrap">
          {head && (
            <div className="small rc-headline" data-testid="chat-run-headline">
              {head}
            </div>
          )}
          <div className={`rc-result ${expanded ? 'open' : ''} ${overflow && !expanded ? 'fade' : ''}`} ref={resultRef} data-testid="chat-run-result">
            <ErrorBoundary
              resetKey={run.id}
              fallback={(err) => (
                <div>
                  <div className="notice warn small">结果的格式化显示出错（{err.message}），以下是原始结果：</div>
                  <pre className="raw">{typeof run.finalOutput === 'string' ? run.finalOutput : JSON.stringify(run.finalOutput, null, 2)}</pre>
                </div>
              )}
            >
              <OutputView value={run.finalOutput} format={run.finalFormat ?? 'markdown'} fields={outNode?.outputFields} grounding={outNode?.validation?.grounding} verification={outNode?.verification} nodeId={outNode?.nodeId} reviews={run.reviews} />
            </ErrorBoundary>
          </div>
          {(overflow || expanded) && (
            <button type="button" className="linkish small" onClick={() => setExpanded((x) => !x)} data-testid="chat-result-toggle">
              {expanded ? '收起结果' : '展开全部结果'}
            </button>
          )}
          <div className="small muted rc-disclaimer">AI 初审草稿，须经具备资质的法律/合规人员复核后使用，不构成法律意见。逐条复核（采纳 / 修改 / 驳回）请在完整运行页进行。</div>
        </div>
      )}

      {(run.status === 'failed' || run.status === 'rejected') && (
        <div data-testid="chat-run-failed">
          {run.error ? <ErrorNotice error={run.error} /> : <div className="notice error small">运行在审批节点被驳回，没有最终结果。</div>}
          {done.length > 0 && (
            <div className="small" style={{ marginTop: 6 }}>
              已完成节点的结果仍可查看：
              {done.map((n) => (
                <Link key={n.nodeId} to={`/runs/${run.id}?node=${n.nodeId}`} style={{ marginLeft: 8 }}>
                  {n.name}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {terminal && log.length > 0 && (
        <details className="rc-process" data-testid="chat-run-process">
          <summary>
            运行过程（{log.length} 条记录{run.finishedAt ? ` · 总用时 ${fmtDuration(run.startedAt ?? run.createdAt, run.finishedAt)}` : ''}）
          </summary>
          <LogLines log={log} t0={t0} testId="chat-run-log-all" />
        </details>
      )}

      <div className="rc-actions">
        <Link className="btn sm" to={`/runs/${run.id}`}>
          查看完整运行
        </Link>
        {terminal && (
          <Link className="btn sm" to={`/runs/${run.id}?replay=1`} data-testid="chat-replay">
            ⟲ 回放过程
          </Link>
        )}
        {terminal && (
          <button className="sm" onClick={() => download(api.runs.exportUrl(run.id, 'md'), `${run.id}.md`).catch((e) => toast((e as Error).message, 'error'))} data-testid="chat-export">
            导出报告
          </button>
        )}
        {terminal && canRerun && (
          <button className="sm" onClick={rerun} disabled={busy} data-testid="chat-rerun">
            {busy ? '启动中…' : '重新运行'}
          </button>
        )}
        {terminal && (
          <button className={`sm ${latest ? 'primary' : ''}`} onClick={() => onAsk(run.id)} data-testid="chat-ask">
            追问这次结果
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── composer ─────────────────────────
function Composer({
  convId,
  draft,
  setDraft,
  mode,
  setMode,
  workflows,
  wfLoading,
  wfId,
  setWfId,
  askRun,
  canAsk,
  canRun,
  onSend,
  focusTick,
  busy,
}: {
  convId?: string;
  draft: Draft;
  setDraft: (d: Draft | ((d: Draft) => Draft)) => void;
  mode: ChatMode;
  setMode: (m: ChatMode) => void;
  workflows: WorkflowView[];
  wfLoading: boolean;
  wfId: string;
  setWfId: (id: string) => void;
  askRun?: string;
  canAsk: boolean;
  canRun: boolean;
  onSend: (p: { mode: ChatMode; text: string; atts: DocumentSummary[]; params: Record<string, string> }) => Promise<void>;
  focusTick: number;
  busy: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [showParams, setShowParams] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const wf = workflows.find((w) => w.id === wfId);
  const extra = (wf?.published?.inputs ?? []).filter((d) => d.type !== 'document');
  const hasDocInput = (wf?.published?.inputs ?? []).some((d) => d.type === 'document');
  const filled = extra.filter((d) => draft.params[d.key]?.trim()).length;

  useEffect(() => {
    if (focusTick) boxRef.current?.querySelector('textarea')?.focus();
  }, [focusTick]);
  useEffect(() => {
    setError(undefined);
  }, [mode]);
  // Switching to another conversation clears what belonged to the previous one (not while sending:
  // the first message of a new conversation changes the address mid-send).
  const sendingRef = useRef(false);
  sendingRef.current = sending;
  useEffect(() => {
    if (sendingRef.current) return;
    setError(undefined);
    setShowParams(false);
  }, [convId]);

  async function upload(files: FileList | File[]) {
    setUploading(true);
    setError(undefined);
    try {
      const docs: DocumentSummary[] = [];
      for (const f of Array.from(files).slice(0, 5)) docs.push(await api.documents.upload(f));
      setDraft((d) => ({ ...d, atts: [...d.atts, ...docs].slice(0, 5) }));
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
    }
  }

  const can = mode === 'ask' ? !!draft.text.trim() && canAsk : (!!draft.text.trim() || draft.atts.length > 0) && !!wf;
  async function submit() {
    if (!can || sending || busy || uploading) return;
    setSending(true);
    setError(undefined);
    const snapshot = draft;
    if (mode === 'ask') setDraft((d) => ({ ...d, text: '' }));
    try {
      await onSend({ mode, text: snapshot.text.trim(), atts: snapshot.atts, params: snapshot.params });
      setDraft((d) => (mode === 'run' ? { ...EMPTY, params: d.params } : d));
    } catch (e) {
      if (mode === 'ask') setDraft(snapshot);
      setError(e);
      const missing = (e as { details?: { fields?: string[] } }).details?.fields ?? [];
      if (missing.some((k) => extra.some((d) => d.key === k))) setShowParams(true);
    } finally {
      setSending(false);
    }
  }

  if (!canRun) {
    return (
      <div className="composer">
        <div className="notice info small">你的角色不能运行工作流，因此不能在对话中发起审阅。可以在“运行记录”中查看被授权的运行。</div>
      </div>
    );
  }

  return (
    <div
      className={`composer ${drag ? 'drag' : ''}`}
      data-testid="chat-composer"
      onDragOver={(e) => {
        if (mode !== 'run') return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (mode !== 'run') return;
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files?.length) upload(e.dataTransfer.files);
      }}
    >
      <div className="composer-top">
        <div className="seg" role="tablist" aria-label="发送方式">
          <button role="tab" aria-selected={mode === 'run'} className={mode === 'run' ? 'on' : ''} onClick={() => setMode('run')} data-testid="chat-mode-run">
            审阅新材料
          </button>
          <button role="tab" aria-selected={mode === 'ask'} className={mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')} disabled={!canAsk} title={canAsk ? '就本对话中的运行结果提问' : '完成一次审阅后才能追问'} data-testid="chat-mode-ask">
            追问结果
          </button>
        </div>
        {mode === 'run' ? (
          <>
            <label className="composer-wf">
              <span className="small muted">工作流</span>
              <select value={wfId} onChange={(e) => setWfId(e.target.value)} disabled={!workflows.length} data-testid="chat-workflow">
                {!workflows.length && <option value="">{wfLoading ? '加载中…' : '没有已发布的工作流'}</option>}
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}（v{w.publishedVersion}）
                  </option>
                ))}
              </select>
            </label>
            {extra.length > 0 && (
              <button type="button" className={`sm ${showParams ? 'on' : ''}`} onClick={() => setShowParams((x) => !x)} aria-expanded={showParams} data-testid="chat-params-toggle">
                参数{filled ? `（已填 ${filled}）` : ''}
              </button>
            )}
          </>
        ) : (
          <span className="small muted" data-testid="chat-ask-target">
            追问对象：运行 {askRun ?? '—'}（回答只依据该次运行的结果、原始材料和规则包）
          </span>
        )}
      </div>

      {mode === 'run' && showParams && extra.length > 0 && (
        <div className="composer-params" data-testid="chat-params">
          {extra.map((d) => (
            <label key={d.key} className="cell">
              <span className="cell-lbl">
                {d.label || d.key}
                {d.required ? ' *' : ''}
              </span>
              <input
                type="text"
                value={draft.params[d.key] ?? ''}
                placeholder={d.defaultValue ? `默认：${d.defaultValue}` : d.description?.slice(0, 40)}
                title={d.description}
                onChange={(e) => setDraft((x) => ({ ...x, params: { ...x.params, [d.key]: e.target.value } }))}
                data-testid={`chat-param-${d.key}`}
              />
            </label>
          ))}
        </div>
      )}

      {mode === 'run' && draft.atts.length > 0 && (
        <div className="composer-atts">
          {draft.atts.map((a) => (
            <span key={a.id} className="att-chip" data-testid="chat-draft-attachment">
              📄 {a.filename}
              <span className="small muted">
                {a.pageCount} 页 · {a.chars.toLocaleString()} 字
              </span>
              <button type="button" className="ghost sm" aria-label={`移除 ${a.filename}`} onClick={() => setDraft((d) => ({ ...d, atts: d.atts.filter((x) => x.id !== a.id) }))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-box" ref={boxRef}>
        {mode === 'run' && (
          <>
            <button type="button" className="ghost attach" onClick={() => fileRef.current?.click()} disabled={uploading || !hasDocInput} title={hasDocInput ? '上传 PDF / Word / 图片 / TXT（≤ 20MB，可拖入）' : '该工作流没有材料文件输入'} aria-label="上传材料" data-testid="chat-attach">
              {uploading ? '…' : '📎'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              data-testid="chat-file"
              onChange={(e) => {
                if (e.target.files?.length) upload(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
        <AutoTextarea
          minRows={1}
          maxRows={10}
          value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={mode === 'run' ? (draft.atts.length ? '补充说明（可选），Enter 发送' : '粘贴材料文字，或点 📎 上传文件；Enter 发送，Shift+Enter 换行') : '就这次结果提问，例如：第 2 条为什么属于高风险？'}
          aria-label={mode === 'run' ? '材料或说明' : '追问内容'}
          data-testid="chat-input"
        />
        <button type="button" className="primary send" onClick={submit} disabled={!can || sending || busy || uploading} data-testid="chat-send">
          {sending ? (mode === 'ask' ? '回答中…' : '启动中…') : '发送'}
        </button>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="composer-hint small muted">
        {mode === 'run' ? '有附件时文字作为说明；没有附件时文字就是待审阅的材料。' : '回答由 AI 根据运行结果生成，仅供参考。'} 材料须为可合法处理的内容，测试请使用虚构或脱敏材料。
      </div>
    </div>
  );
}
