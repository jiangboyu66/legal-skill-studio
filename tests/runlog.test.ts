import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HIGH_RISK_EDM, LOW_RISK_POST } from '../server/seed/samples';
import { deriveLog, runLog } from '../shared/runlog';
import type { Me, Run, RunEvent, RunLogEntry } from '../shared/types';
import { applyEvent, mergeLog, mergeRun, runStatusAt, statusesAt } from '../src/components/runLive';
import { startApp, type TestApp, WF } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
  await t.login('builder', 'runner', 'reviewer');
  await t.approveSeedRulePack();
});
afterAll(() => t.stop());

const start = (who: string, body: Record<string, unknown>) => t.call<Run>(who, 'POST', `/api/workflows/${WF}/runs`, body);

describe('run activity log ("运行过程")', () => {
  it('records each step with node, status and time, streams it live and keeps it after the run', async () => {
    // capture everything the engine publishes (the run may finish before a subscriber could attach)
    const live: RunLogEntry[] = [];
    const bus = t.ctx.events;
    const publish = bus.publish.bind(bus);
    bus.publish = (e: RunEvent) => {
      if (e.type === 'log') live.push(e.entry);
      publish(e);
    };
    const r = await start('runner', { mode: 'production', inputs: { material: LOW_RISK_POST, channel: 'Instagram' } });
    const done = await t.waitRun('runner', r.body.id, ['succeeded', 'failed']);
    bus.publish = publish;
    expect(done.status).toBe('succeeded');
    const log = done.log!;
    expect(log.length).toBeGreaterThan(8);
    expect(log.map((e) => e.seq)).toEqual(log.map((_e, i) => i + 1));
    expect(log[0]).toMatchObject({ kind: 'run', status: 'queued' });
    expect(log[0].text).toContain('运行已创建');
    expect(log.some((e) => e.kind === 'run' && e.status === 'running' && e.text.startsWith('开始执行'))).toBe(true);
    expect(log.at(-1)).toMatchObject({ kind: 'run', status: 'succeeded' });
    expect(log.at(-1)!.text).toContain('运行完成');
    // every executed node has a start and a finish line, in order
    for (const id of done.order.filter((n) => done.nodes[n].status === 'succeeded')) {
      const s = log.findIndex((e) => e.nodeId === id && e.status === 'running');
      const f = log.findIndex((e) => e.nodeId === id && e.status === 'succeeded');
      expect(s, id).toBeGreaterThan(0);
      expect(f, id).toBeGreaterThan(s);
    }
    // skipped nodes say why; agent steps (model wait, tool calls) are visible
    expect(log.some((e) => e.status === 'skipped' && e.text.includes('跳过'))).toBe(true);
    expect(log.some((e) => e.kind === 'model' && e.text.includes('等待模型回复'))).toBe(true);
    expect(log.some((e) => e.kind === 'tool' && /查阅规则|在材料中搜索/.test(e.text))).toBe(true);
    // what was streamed is what was stored
    const mine = live.filter((e) => log.some((x) => x.at === e.at && x.seq === e.seq));
    expect(mine.length).toBe(log.length);
    for (const e of mine) expect(log.find((x) => x.seq === e.seq)?.text).toBe(e.text);
    // persisted (not only in memory)
    expect(t.ctx.db.runs.get('org_demo', done.id)!.log!.length).toBe(log.length);
  });

  it('logs approval pauses and decisions', async () => {
    const r = await start('runner', { mode: 'production', inputs: { material: HIGH_RISK_EDM, channel: 'EDM' } });
    const waiting = await t.waitRun('runner', r.body.id, ['waiting_approval', 'failed']);
    expect(waiting.log!.some((e) => e.kind === 'approval' && e.nodeId === 'legal_approval' && e.status === 'waiting_approval')).toBe(true);
    expect(waiting.log!.at(-1)).toMatchObject({ kind: 'run', status: 'waiting_approval' });
    await t.call('reviewer', 'POST', `/api/runs/${waiting.id}/nodes/legal_approval/decision`, { decision: 'approved', comment: '可以' });
    const done = await t.waitRun('runner', waiting.id, ['succeeded', 'failed']);
    expect(done.log!.some((e) => e.kind === 'approval' && e.text.includes('批准'))).toBe(true);
    expect(done.log!.some((e) => e.text === '审批完成，继续执行')).toBe(true);
  });

  it('rebuilds an approximate log for runs recorded before activity logs existed', async () => {
    const r = await start('runner', { mode: 'production', inputs: { material: LOW_RISK_POST } });
    const done = await t.waitRun('runner', r.body.id, ['succeeded', 'failed']);
    const old: Run = { ...done, log: undefined };
    const d = deriveLog(old);
    expect(d.every((e) => e.approx)).toBe(true);
    expect(d[0].text).toContain('运行已创建');
    expect(d.at(-1)!.text).toContain('运行完成');
    expect(d.map((e) => e.seq)).toEqual(d.map((_e, i) => i + 1));
    const times = d.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(d.some((e) => e.nodeId === 'check' && e.status === 'succeeded')).toBe(true);
    expect(runLog(old)).toEqual(d);
    expect(runLog(done)).toBe(done.log);
  });
});

describe('client helpers for live runs and replay', () => {
  const entry = (seq: number, extra: Partial<RunLogEntry> = {}): RunLogEntry => ({ seq, at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), kind: 'note', text: `#${seq}`, ...extra });

  it('merges logs by sequence and never moves a finished run back to running', () => {
    expect(mergeLog([entry(1), entry(2)], [entry(2, { text: 'new' }), entry(3)]).map((e) => e.text)).toEqual(['#1', 'new', '#3']);
    const base = { id: 'run_x', status: 'succeeded', nodes: {}, log: [entry(1), entry(2)] } as unknown as Run;
    const stale = { ...base, status: 'running', log: [entry(1)] } as Run;
    expect(mergeRun(base, stale)).toBe(base);
    const newer = { ...base, log: [entry(1), entry(2), entry(3)] } as Run;
    expect(mergeRun(base, newer).log).toHaveLength(3);
  });

  it('applies only additive events locally; status changes wait for the reload (no half-updated nodes)', () => {
    const run = { id: 'run_x', status: 'running', nodes: { a: { nodeId: 'a', status: 'running', transcript: [] } }, log: [entry(1)] } as unknown as Run;
    // a node "waiting_approval" without its approval request would break the approval panel
    expect(applyEvent(run, { type: 'node_status', runId: 'run_x', nodeId: 'a', status: 'waiting_approval' })).toBe(run);
    expect(applyEvent(run, { type: 'run_status', runId: 'run_x', status: 'succeeded' })).toBe(run);
    expect(applyEvent(run, { type: 'log', runId: 'run_x', entry: entry(2) }).log).toHaveLength(2);
    expect(applyEvent(run, { type: 'transcript', runId: 'run_x', nodeId: 'a', entry: { type: 'note', turn: 1, message: 'x' } }).nodes.a.transcript).toHaveLength(1);
  });

  it('computes node and run states at a replay position', () => {
    const run = { order: ['a', 'b'] } as unknown as Run;
    const log = [entry(1, { kind: 'run', status: 'queued' }), entry(2, { kind: 'run', status: 'running' }), entry(3, { kind: 'node', nodeId: 'a', status: 'running' }), entry(4, { kind: 'node', nodeId: 'a', status: 'succeeded' }), entry(5, { kind: 'node', nodeId: 'b', status: 'running' }), entry(6, { kind: 'error', nodeId: 'b', status: 'failed' }), entry(7, { kind: 'error', status: 'failed' })];
    expect(statusesAt(run, log, 3)).toEqual({ a: 'running', b: 'pending' });
    expect(statusesAt(run, log, 6)).toEqual({ a: 'succeeded', b: 'failed' });
    expect(runStatusAt(log, 2)).toBe('running');
    expect(runStatusAt(log, 7)).toBe('failed');
  });
});

describe('per-tab sessions (two roles side by side in one browser)', () => {
  const tab = (token?: string, cookieOf?: string) => ({ headers: { 'x-session-mode': 'tab', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookieOf ? { cookie: t.cookies[cookieOf] } : {}) } });

  it('uses the tab token over the shared cookie, and logging out one tab keeps the other', async () => {
    const a = await t.call<Me>('runA', 'POST', '/api/auth/login', { email: 'runner@demo.local', password: (await import('../server/seed')).demoPassword('runner@demo.local') });
    const b = await t.call<Me>('revB', 'POST', '/api/auth/login', { email: 'reviewer@demo.local', password: (await import('../server/seed')).demoPassword('reviewer@demo.local') });
    expect(a.body.sessionToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(b.body.sessionToken).not.toBe(a.body.sessionToken);

    // the browser's shared cookie now belongs to the reviewer (last login), but tab A still acts as the runner
    const meA = await t.call<Me>('x', 'GET', '/api/auth/me', undefined, tab(a.body.sessionToken, 'revB'));
    expect(meA.body.user.role).toBe('runner');
    // a tab without its own token does not fall back to another tab's cookie
    expect((await t.call('x', 'GET', '/api/auth/me', undefined, tab(undefined, 'revB'))).status).toBe(401);
    // plain cookie sessions (API clients, older pages) still work
    expect((await t.call<Me>('revB', 'GET', '/api/auth/me')).body.user.role).toBe('reviewer');

    expect((await t.call('x', 'POST', '/api/auth/logout', {}, tab(a.body.sessionToken, 'revB'))).status).toBe(200);
    expect((await t.call('x', 'GET', '/api/auth/me', undefined, tab(a.body.sessionToken))).status).toBe(401);
    expect((await t.call<Me>('x', 'GET', '/api/auth/me', undefined, tab(b.body.sessionToken))).body.user.role).toBe('reviewer');
    expect((await t.call<Me>('revB', 'GET', '/api/auth/me')).status).toBe(200); // the reviewer's cookie was not cleared
  });

  it('gives a new tab its own session, so signing out there keeps the original tab signed in', async () => {
    const pw = (await import('../server/seed')).demoPassword('builder@demo.local');
    const first = await t.call<Me>('tab1', 'POST', '/api/auth/login', { email: 'builder@demo.local', password: pw });
    const tok = first.body.sessionToken!;
    const fork = await t.call<{ sessionToken: string }>('x', 'POST', '/api/auth/fork', {}, tab(tok));
    expect(fork.status).toBe(200);
    expect(fork.body.sessionToken).not.toBe(tok);
    expect((await t.call<Me>('x', 'GET', '/api/auth/me', undefined, tab(fork.body.sessionToken))).body.user.role).toBe('builder');
    await t.call('x', 'POST', '/api/auth/logout', {}, tab(fork.body.sessionToken));
    expect((await t.call('x', 'GET', '/api/auth/me', undefined, tab(fork.body.sessionToken))).status).toBe(401);
    expect((await t.call<Me>('x', 'GET', '/api/auth/me', undefined, tab(tok))).body.user.role).toBe('builder');
    expect((await t.call('x', 'POST', '/api/auth/fork', {}, tab('not-a-valid-token-but-long-enough'))).status).toBe(401);
  });
});
