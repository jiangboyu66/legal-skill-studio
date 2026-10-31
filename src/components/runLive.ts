import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeRun, NodeStatus, Run, RunEvent, RunLogEntry, RunStatus } from '../../shared/types';
import { api, ApiError, streamRunEvents } from '../api';

export const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'rejected', 'canceled'];

/** Reasoning text streaming in right now, per node ("深度思考"); replaced by the stored entry when complete. */
export type LiveThinking = Record<string, { key: string; text: string; agent?: string }>;

/** Applies a streamed reasoning chunk (a new key starts a new model call or retry). */
export function applyThinking(cur: LiveThinking, e: Extract<RunEvent, { type: 'thinking_delta' }>): LiveThinking {
  const prev = cur[e.nodeId];
  const text = prev && prev.key === e.key ? prev.text + e.text : e.text;
  return { ...cur, [e.nodeId]: { key: e.key, text: text.length > 12_000 ? `…${text.slice(-12_000)}` : text, agent: e.agent } };
}
export const isTerminal = (s?: string) => !!s && (TERMINAL as string[]).includes(s);

/** Merges two activity logs by sequence number (later copies win). */
export function mergeLog(a: RunLogEntry[] = [], b: RunLogEntry[] = []): RunLogEntry[] {
  if (!b.length) return a;
  if (!a.length) return b;
  const m = new Map<number, RunLogEntry>();
  for (const e of a) m.set(e.seq, e);
  for (const e of b) m.set(e.seq, e);
  return [...m.values()].sort((x, y) => x.seq - y.seq);
}

/**
 * Combines a freshly loaded run with what the page already shows. Never moves a finished run back to an
 * unfinished state (an older response can arrive after a newer one), and keeps live log / transcript
 * entries that arrived over the event stream after the request was sent.
 */
export function mergeRun(prev: Run | null, next: Run): Run {
  if (!prev || prev.id !== next.id) return next;
  if (isTerminal(prev.status) && !isTerminal(next.status)) return prev;
  const nodes: Record<string, NodeRun> = { ...next.nodes };
  for (const [id, n] of Object.entries(next.nodes)) {
    const p = prev.nodes[id];
    if (p && p.startedAt === n.startedAt && (p.transcript?.length ?? 0) > (n.transcript?.length ?? 0) && !isTerminal(n.status as string)) {
      nodes[id] = { ...n, transcript: p.transcript };
    }
  }
  return { ...next, nodes, log: mergeLog(prev.log, next.log) };
}

/**
 * Applies the events that only ADD information (activity log lines, agent transcript) directly. Status
 * changes are never applied locally: a node that is "waiting_approval" needs its approval request, a
 * "succeeded" one its output — the page reloads the run instead, so it never shows a half-updated state.
 */
export function applyEvent(run: Run, e: RunEvent): Run {
  switch (e.type) {
    case 'log':
      return { ...run, log: mergeLog(run.log, [e.entry]) };
    case 'transcript': {
      const n = run.nodes[e.nodeId];
      if (!n) return run;
      return { ...run, nodes: { ...run.nodes, [e.nodeId]: { ...n, transcript: [...(n.transcript ?? []), e.entry] } } };
    }
    default:
      return run;
  }
}

export interface RunLiveState {
  run: Run | null;
  /** Error of the first load (nothing to show yet). */
  error: unknown;
  /** Error of a later refresh: the last good state stays on screen. */
  refreshError: unknown;
  /** The event stream is connected. */
  live: boolean;
  /** Reasoning streaming in right now, per node. */
  thinking: LiveThinking;
  active: boolean;
  reload: () => void;
  setRun: (fn: (r: Run | null) => Run | null) => void;
}

/**
 * Loads a run and keeps it current while it executes: server-sent events append log lines and agent
 * transcript as they happen; status changes trigger a reload (throttled). Responses that arrive out of
 * order are ignored, and a failed refresh never replaces what is already on screen.
 */
export function useRunLive(runId: string | undefined): RunLiveState {
  const [run, setRunState] = useState<Run | null>(null);
  const [error, setError] = useState<unknown>();
  const [refreshError, setRefreshError] = useState<unknown>();
  const [live, setLive] = useState(false);
  const [thinking, setThinking] = useState<LiveThinking>({});
  const runRef = useRef<Run | null>(null);
  const idRef = useRef(runId);
  idRef.current = runId;
  const reqSeq = useRef(0);
  const applied = useRef(0);
  const inFlight = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const lastLoad = useRef(0);
  const loadRef = useRef<() => void>(() => {});

  const setRun = useCallback((fn: (r: Run | null) => Run | null) => {
    setRunState((r) => {
      const next = fn(r);
      runRef.current = next;
      return next;
    });
  }, []);

  const load = useCallback(() => {
    if (!runId) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    lastLoad.current = Date.now();
    const my = ++reqSeq.current;
    api.runs
      .get(runId)
      .then((r) => {
        // Ignore answers for another run (the page moved on) or older than one already applied.
        if (runId !== idRef.current || r.id !== runId || my < applied.current) return;
        applied.current = my;
        setRun((prev) => mergeRun(prev, r));
        setError(undefined);
        setRefreshError(undefined);
      })
      .catch((e) => {
        if (runId !== idRef.current) return;
        if (runRef.current?.id === runId) setRefreshError(e);
        else setError(e);
      })
      .finally(() => {
        inFlight.current = false;
        if (again.current) {
          again.current = false;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => loadRef.current(), 300);
        }
      });
  }, [runId, setRun]);
  loadRef.current = load;

  /** Throttled reload: at most one request every ~1.2 s while events keep coming. */
  const soon = useCallback(
    (immediate = false) => {
      clearTimeout(timer.current);
      const wait = immediate ? 0 : Math.max(0, 1200 - (Date.now() - lastLoad.current));
      timer.current = setTimeout(() => loadRef.current(), wait);
    },
    [],
  );

  useEffect(() => {
    runRef.current = null;
    setRunState(null);
    setThinking({});
    setError(undefined);
    setRefreshError(undefined);
    inFlight.current = false;
    again.current = false;
    applied.current = reqSeq.current;
    load();
    return () => clearTimeout(timer.current);
  }, [load]);

  const active = !!run && !isTerminal(run.status);
  const waiting = run?.status === 'waiting_approval';

  useEffect(() => {
    if (!runId || !active) return;
    let poll: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const startPoll = (ms: number) => {
      if (poll) clearInterval(poll);
      poll = setInterval(() => soon(true), ms);
    };
    // Safety net even while the stream is open (a proxy may buffer events); faster when it is not.
    startPoll(waiting ? 8000 : 5000);
    const close = streamRunEvents(runId, {
      onOpen: () => {
        setLive(true);
        soon(true); // catch up with anything that happened before the stream opened
      },
      onEvent: (e) => {
        if (e.runId !== runId) return;
        if (e.type === 'thinking_delta') {
          setThinking((cur) => applyThinking(cur, e));
          return;
        }
        // the complete reasoning of a call was recorded, or the node moved on: drop the live text
        if ((e.type === 'transcript' && e.entry.type === 'thinking') || (e.type === 'node_status' && e.status !== 'running')) {
          const nodeId = e.nodeId;
          setThinking((cur) => {
            if (!cur[nodeId]) return cur;
            const next = { ...cur };
            delete next[nodeId];
            return next;
          });
        }
        if (e.type === 'log' || e.type === 'transcript') setRun((r) => (r && r.id === e.runId ? applyEvent(r, e) : r));
        // status changes: reload right away (throttled while many arrive)
        if (e.type === 'run_status' || e.type === 'approval_requested' || e.type === 'approval_decided') soon(true);
        else if (e.type === 'node_status') soon(e.status !== 'running' && e.status !== 'pending');
        else if (e.type === 'log' && (e.entry.kind === 'node' || e.entry.kind === 'run')) soon();
      },
      onClose: (err) => {
        setLive(false);
        if (closed) return;
        if (err instanceof ApiError && err.status === 401) return;
        startPoll(1500);
      },
    });
    return () => {
      closed = true;
      close();
      if (poll) clearInterval(poll);
      setLive(false);
    };
  }, [runId, active, waiting, soon, setRun]);

  useEffect(() => {
    if (!active) setThinking({});
  }, [active]);

  // Final reload once the run has finished, so the complete result (outputs, usage) is shown.
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) wasActive.current = true;
    else if (wasActive.current && run) {
      wasActive.current = false;
      soon(true);
    }
  }, [active, run, soon]);

  return { run, error, refreshError, live, thinking, active, reload: () => soon(true), setRun };
}

/** Re-renders every `ms` while `on` (elapsed time displays). */
export function useTicker(on: boolean, ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [on, ms]);
}

/** Node statuses as of log entry `upto` (1-based seq), for replay. */
export function statusesAt(run: Run, log: RunLogEntry[], upto: number): Record<string, NodeStatus> {
  const st: Record<string, NodeStatus> = Object.fromEntries(run.order.map((id) => [id, 'pending' as NodeStatus]));
  for (const e of log) {
    if (e.seq > upto) break;
    if (e.nodeId && e.status && e.nodeId in st) st[e.nodeId] = e.status as NodeStatus;
  }
  return st;
}

/** Run status as of log entry `upto`. */
export function runStatusAt(log: RunLogEntry[], upto: number): RunStatus {
  let s: RunStatus = 'queued';
  for (const e of log) {
    if (e.seq > upto) break;
    if (e.kind === 'run' && e.status) s = e.status as RunStatus;
    else if (e.kind === 'error' && !e.nodeId && e.status) s = e.status as RunStatus;
  }
  return s;
}
