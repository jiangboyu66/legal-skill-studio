import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NodeStatus, Run, RunLogEntry } from '../../shared/types';
import type { LiveThinking } from './runLive';
import { StatusBadge } from './ui';

const ICON: Record<RunLogEntry['kind'], string> = { run: '▶', node: '●', model: '…', thinking: '💭', tool: '🔧', result: '↩', approval: '✋', note: 'ℹ', error: '⚠' };
const KEY_KINDS: RunLogEntry['kind'][] = ['run', 'node', 'approval', 'error'];

const pad = (n: number) => String(n).padStart(2, '0');
export function clock(iso?: string) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const secs = (ms: number) => (ms < 0 ? '0.0' : (ms / 1000).toFixed(1));

// ───────────────────────── replay ─────────────────────────
export interface Replay {
  on: boolean;
  /** Index into the log (0-based) of the current step. */
  pos: number;
  playing: boolean;
  speed: number;
  current?: RunLogEntry;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  seek: (i: number) => void;
  step: (d: number) => void;
  setSpeed: (s: number) => void;
}

/**
 * Replays a recorded activity log: steps through entries with (compressed) real time gaps, so the graph
 * and the log re-run the way the run actually went.
 */
export function useReplay(log: RunLogEntry[], autoStart = false): Replay {
  const [on, setOn] = useState(false);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const n = log.length;
  const started = useRef(false);

  useEffect(() => {
    if (autoStart && !started.current && n > 0) {
      started.current = true;
      setOn(true);
      setPos(0);
      setPlaying(true);
    }
  }, [autoStart, n]);

  useEffect(() => {
    if (!on || !playing) return;
    if (pos >= n - 1) {
      setPlaying(false);
      return;
    }
    const gap = Date.parse(log[pos + 1].at) - Date.parse(log[pos].at);
    const wait = Math.max(120, Math.min(1500, (Number.isFinite(gap) ? gap : 400) / speed));
    const t = setTimeout(() => setPos((p) => Math.min(n - 1, p + 1)), wait);
    return () => clearTimeout(t);
  }, [on, playing, pos, n, speed, log]);

  const clampPos = useCallback((i: number) => Math.max(0, Math.min(n - 1, i)), [n]);
  return {
    on,
    pos: on ? clampPos(pos) : n - 1,
    playing,
    speed,
    current: on ? log[clampPos(pos)] : undefined,
    start: () => {
      setOn(true);
      setPos(0);
      setPlaying(true);
    },
    stop: () => {
      setOn(false);
      setPlaying(false);
    },
    toggle: () => {
      if (pos >= n - 1) setPos(0);
      setPlaying((p) => !p);
    },
    seek: (i) => {
      setPos(clampPos(i));
      setPlaying(false);
    },
    step: (d) => {
      setPos((p) => clampPos(p + d));
      setPlaying(false);
    },
    setSpeed,
  };
}

// ───────────────────────── node tooltip ─────────────────────────
export function NodeTip({ run, nodeId, log, status, upto }: { run: Run; nodeId: string; log: RunLogEntry[]; status?: NodeStatus; upto?: number }) {
  const n = run.nodes[nodeId];
  const def = run.definition.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  const entries = log.filter((e) => e.nodeId === nodeId && (upto === undefined || e.seq <= upto));
  const st = status ?? n.status;
  const finished = st === 'succeeded' || st === 'failed' || st === 'skipped' || st === 'rejected';
  const startedAt = entries.find((e) => e.status === 'running' || e.status === 'waiting_approval')?.at ?? (upto === undefined ? n.startedAt : undefined);
  const endAt = finished ? (entries.filter((e) => e.status === st).pop()?.at ?? n.finishedAt) : undefined;
  const refNow = upto !== undefined ? log.find((e) => e.seq === upto)?.at : new Date().toISOString();
  const elapsed = startedAt ? Date.parse(endAt ?? refNow ?? new Date().toISOString()) - Date.parse(startedAt) : undefined;
  const recent = entries.slice(-4);
  const showStats = finished && upto === undefined;
  const g = n.validation?.grounding ?? [];
  return (
    <div className="tip">
      <div className="tip-head">
        <strong>{n.name}</strong>
        <StatusBadge status={st} />
      </div>
      <div className="tip-sub">
        {n.type === 'skill' ? `Skill「${n.skillName ?? ''}」${n.skillVersion === 'draft' ? '草稿' : `v${n.skillVersion}`}` : '人工审批节点'}
        {def?.when ? ` · 条件：${def.when}` : ''}
        {n.reusedFrom ? ` · 复用 ${n.reusedFrom}` : ''}
      </div>
      <dl className="tip-kv">
        {startedAt && (
          <>
            <dt>开始</dt>
            <dd>{clock(startedAt)}</dd>
          </>
        )}
        {elapsed !== undefined && Number.isFinite(elapsed) && (
          <>
            <dt>{finished ? '用时' : '已运行'}</dt>
            <dd>{secs(n.latencyMs !== undefined && showStats ? n.latencyMs : elapsed)} s</dd>
          </>
        )}
        {showStats && n.turns ? (
          <>
            <dt>模型轮次</dt>
            <dd>
              {n.turns} 轮{n.attempts && n.attempts > 1 ? `（调用 ${n.attempts} 次）` : ''}
            </dd>
          </>
        ) : null}
        {showStats && n.usage?.inputTokens !== undefined && (
          <>
            <dt>token</dt>
            <dd>
              {n.usage.inputTokens.toLocaleString()} / {(n.usage.outputTokens ?? 0).toLocaleString()}
            </dd>
          </>
        )}
        {showStats &&
          g.map((x) => (
            <span key={x.checkId} style={{ display: 'contents' }}>
              <dt>{x.label}</dt>
              <dd className={x.note ? '' : x.passed === x.total ? 'ok' : 'bad'}>{x.note ? '未执行' : `${x.passed}/${x.total}`}</dd>
            </span>
          ))}
        {showStats && n.verification && (
          <>
            <dt>结论核验</dt>
            <dd>
              {n.verification.summary.flagged} 条优先复核 / 共 {n.verification.items.length} 条
            </dd>
          </>
        )}
      </dl>
      {recent.length > 0 ? (
        <ol className="tip-log">
          {recent.map((e) => (
            <li key={e.seq} className={`k-${e.kind}`}>
              <span className="t">{clock(e.at)}</span> {e.text}
            </li>
          ))}
        </ol>
      ) : (
        <div className="tip-empty">{st === 'pending' ? '尚未开始：等待上游节点完成。' : '没有过程记录。'}</div>
      )}
      {st === 'failed' && n.error && upto === undefined && <div className="tip-err">{n.error.message}</div>}
      {st === 'skipped' && n.skipReason && <div className="tip-note">跳过原因：{n.skipReason}</div>}
      {n.approval && finished && (
        <div className="tip-note">
          {n.approval.decision === 'approved' ? '已批准' : '已驳回'} · {n.approval.byName}
          {n.approval.comment ? `：${n.approval.comment}` : ''}
        </div>
      )}
      <div className="tip-foot">点击节点查看完整结果与 AI 过程</div>
    </div>
  );
}

// ───────────────────────── activity log panel ─────────────────────────
export function RunProcess({
  run,
  log,
  active,
  live,
  replay,
  onPickNode,
  onHoverNode,
  defaultOpen,
  thinking = {},
}: {
  run: Run;
  log: RunLogEntry[];
  active: boolean;
  live: boolean;
  replay: Replay;
  onPickNode?: (id: string) => void;
  onHoverNode?: (id?: string) => void;
  defaultOpen: boolean;
  /** Reasoning streaming in right now ("深度思考"). */
  thinking?: LiveThinking;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [nodeFilter, setNodeFilter] = useState('');
  const [keyOnly, setKeyOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLOListElement>(null);
  const approx = log.some((e) => e.approx);
  const t0 = log[0] ? Date.parse(log[0].at) : 0;

  useEffect(() => {
    if (active || replay.on) setOpen(true);
  }, [active, replay.on]);

  const shown = useMemo(() => {
    const limit = replay.on ? replay.pos : log.length - 1;
    return log.filter((e, i) => i <= limit && (!nodeFilter || e.nodeId === nodeFilter) && (!keyOnly || KEY_KINDS.includes(e.kind)));
  }, [log, replay.on, replay.pos, nodeFilter, keyOnly]);
  const hidden = replay.on ? log.length - 1 - replay.pos : 0;
  const liveThinking = replay.on ? [] : Object.entries(thinking).filter(([id, t]) => t.text && (!nodeFilter || id === nodeFilter));
  const thinkingSize = liveThinking.reduce((n, [, t]) => n + t.text.length, 0);

  // Live: stick to the newest line unless the reader scrolled up. Replay: keep the current step in view.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !open) return;
    if (replay.on) {
      const cur = el.querySelector<HTMLElement>('li.cur');
      if (cur && (cur.offsetTop < el.scrollTop || cur.offsetTop + cur.offsetHeight > el.scrollTop + el.clientHeight)) el.scrollTop = cur.offsetTop - el.clientHeight / 2;
    } else if (follow) el.scrollTop = el.scrollHeight;
  }, [shown.length, open, replay.on, replay.pos, follow, thinkingSize]);

  const end = run.finishedAt ? Date.parse(run.finishedAt) : undefined;
  const total = end && t0 ? `总用时 ${secs(end - t0)} s` : '';

  return (
    <section className="panel process" data-testid="run-process">
      <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <h2 className="section" style={{ margin: 0 }}>
            运行过程
          </h2>
          <span className="small muted" data-testid="process-count">
            {log.length} 条记录{total ? ` · ${total}` : ''}
          </span>
          {active && !replay.on && <span className={`badge ${live ? 'run' : ''}`}>{live ? '实时' : '自动刷新'}</span>}
          {replay.on && (
            <span className="badge warn" data-testid="replay-badge">
              回放中
            </span>
          )}
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {open && (
            <>
              <select value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)} aria-label="按节点筛选" className="sm-select" data-testid="process-node-filter">
                <option value="">全部节点</option>
                {run.order.map((id) => (
                  <option key={id} value={id}>
                    {run.nodes[id]?.name ?? id}
                  </option>
                ))}
              </select>
              <label className="check small">
                <input type="checkbox" checked={keyOnly} onChange={(e) => setKeyOnly(e.target.checked)} /> 只看关键步骤
              </label>
            </>
          )}
          {!replay.on && log.length > 1 && !active && (
            <button className="sm" onClick={replay.start} data-testid="replay-start">
              ⟲ 回放过程
            </button>
          )}
          <button className="sm ghost" onClick={() => setOpen((x) => !x)} aria-expanded={open} data-testid="process-toggle">
            {open ? '收起' : `展开全部 ${log.length} 条`}
          </button>
        </div>
      </div>

      {replay.on && <ReplayBar replay={replay} log={log} t0={t0} />}

      {approx && open && <div className="field-help">此运行记录于过程日志功能上线前：节点起止时间为真实记录，中间步骤的时间为推算值（≈）。</div>}

      {!open ? (
        <div className="process-peek small" onClick={() => setOpen(true)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)}>
          {log.slice(-2).map((e) => (
            <div key={e.seq} className={`k-${e.kind}`}>
              <span className="t">{clock(e.at)}</span> {e.text}
            </div>
          ))}
        </div>
      ) : (
        <ol
          className="process-log"
          ref={box}
          aria-live={active && !replay.on ? 'polite' : undefined}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 28);
          }}
          data-testid="process-log"
        >
          {shown.length === 0 && <li className="muted">还没有记录。</li>}
          {shown.map((e) => {
            const node = e.nodeId ? run.nodes[e.nodeId] : undefined;
            const cur = replay.on && replay.current?.seq === e.seq;
            return (
              <li
                key={e.seq}
                className={`k-${e.kind} ${cur ? 'cur' : ''}`}
                data-seq={e.seq}
                onMouseEnter={() => e.nodeId && onHoverNode?.(e.nodeId)}
                onMouseLeave={() => onHoverNode?.(undefined)}
              >
                <span className="t" title={new Date(e.at).toLocaleString('zh-CN', { hour12: false })}>
                  {e.approx ? '≈' : ''}
                  {clock(e.at)}
                  <span className="rel">+{secs(Date.parse(e.at) - t0)}s</span>
                </span>
                <span className="i" aria-hidden>
                  {ICON[e.kind]}
                </span>
                <span className="x">
                  {node && (
                    <button type="button" className="node-chip" onClick={() => onPickNode?.(node.nodeId)} title="查看该节点">
                      {node.name}
                    </button>
                  )}
                  {e.status && e.kind !== 'tool' && <StatusDot status={e.status as NodeStatus} />}
                  {e.text}
                  {e.detail && (
                    <details className="more">
                      <summary>全文</summary>
                      <pre>{e.detail}</pre>
                    </details>
                  )}
                </span>
              </li>
            );
          })}
          {hidden > 0 && <li className="muted small">…之后还有 {hidden} 条（继续播放或拖动进度条查看）</li>}
          {liveThinking.map(([id, t]) => (
            <li key={`thinking-${id}`} className="k-thinking live" data-testid="live-thinking">
              <span className="t">思考中</span>
              <span className="i" aria-hidden>
                💭
              </span>
              <span className="x">
                {run.nodes[id] && (
                  <button type="button" className="node-chip" onClick={() => onPickNode?.(id)}>
                    {run.nodes[id].name}
                  </button>
                )}
                {t.agent === 'verifier' ? '核验代理：' : ''}
                <span className="thinking-live">{t.text.length > 1200 ? `…${t.text.slice(-1200)}` : t.text}</span>
                <span className="caret" aria-hidden />
              </span>
            </li>
          ))}
        </ol>
      )}
      {open && !follow && !replay.on && active && (
        <button
          className="sm follow-btn"
          onClick={() => {
            setFollow(true);
            if (box.current) box.current.scrollTop = box.current.scrollHeight;
          }}
        >
          ↓ 跟随最新
        </button>
      )}
    </section>
  );
}

function StatusDot({ status }: { status: NodeStatus }) {
  return <span className={`sdot s-${status}`} aria-hidden />;
}

function ReplayBar({ replay, log, t0 }: { replay: Replay; log: RunLogEntry[]; t0: number }) {
  const cur = replay.current;
  return (
    <div className="replay-bar" data-testid="replay-bar">
      <div className="row" style={{ gap: 4 }}>
        <button className="sm" onClick={() => replay.seek(0)} title="回到开头" aria-label="回到开头" data-testid="replay-first">
          ⏮
        </button>
        <button className="sm" onClick={() => replay.step(-1)} title="上一步" aria-label="上一步" data-testid="replay-prev">
          ◀
        </button>
        <button className="sm primary" onClick={replay.toggle} data-testid="replay-toggle" aria-label={replay.playing ? '暂停' : '播放'}>
          {replay.playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button className="sm" onClick={() => replay.step(1)} title="下一步" aria-label="下一步" data-testid="replay-next">
          ▶
        </button>
        <button className="sm" onClick={() => replay.seek(log.length - 1)} title="跳到结束" aria-label="跳到结束" data-testid="replay-end">
          ⏭
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, log.length - 1)}
        value={replay.pos}
        onChange={(e) => replay.seek(Number(e.target.value))}
        aria-label="回放进度"
        data-testid="replay-slider"
      />
      <span className="small mono" data-testid="replay-pos">
        {replay.pos + 1}/{log.length}
        {cur ? ` · +${secs(Date.parse(cur.at) - t0)}s` : ''}
      </span>
      <select className="sm-select" value={replay.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} aria-label="回放速度">
        {[1, 2, 4, 8].map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <button className="sm ghost" onClick={replay.stop} data-testid="replay-stop">
        退出回放
      </button>
    </div>
  );
}
