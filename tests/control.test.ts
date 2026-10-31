import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HIGH_RISK_EDM, LOW_RISK_POST } from '../server/seed/samples';
import { eventForViewer, runForViewer } from '../server/routes/views';
import type { ChatSendResult, Conversation, Run, RunEvent } from '../shared/types';
import { startApp, type TestApp, WF } from './helpers';

/** "深度思考" (print the model's reasoning) and "停止" (stop a run / an answer). Mock model with latency. */
let t: TestApp;
beforeAll(async () => {
  t = await startApp({ config: { mockLatencyMs: 250 } });
  await t.login('builder', 'runner', 'reviewer', 'admin');
  await t.approveSeedRulePack();
});
afterAll(() => t.stop());

const start = (who: string, body: Record<string, unknown>) => t.call<Run>(who, 'POST', `/api/workflows/${WF}/runs`, body);
const until = async (who: string, id: string, ok: (r: Run) => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = (await t.call<Run>(who, 'GET', `/api/runs/${id}`)).body;
    if (ok(r)) return r;
    if (Date.now() > end) throw new Error(`run ${id} stuck in ${r.status}`);
    await new Promise((x) => setTimeout(x, 40));
  }
};

describe('深度思考: the model reasoning is printed live and kept with the run', () => {
  it('records thinking per turn (main agent and verifier), streams it while the call runs, and logs it', async () => {
    const deltas: Extract<RunEvent, { type: 'thinking_delta' }>[] = [];
    const bus = t.ctx.events;
    const publish = bus.publish.bind(bus);
    bus.publish = (e: RunEvent) => {
      if (e.type === 'thinking_delta') deltas.push(e);
      publish(e);
    };
    const r = await start('builder', { mode: 'production', inputs: { material: HIGH_RISK_EDM, channel: 'EDM' }, options: { showThinking: true } });
    expect(r.body.options).toEqual({ showThinking: true });
    const run = await t.waitRun('builder', r.body.id, ['waiting_approval', 'failed']);
    bus.publish = publish;
    expect(run.status).toBe('waiting_approval');
    const check = run.nodes.check.transcript!;
    const thoughts = check.filter((e) => e.type === 'thinking');
    expect(thoughts.length).toBeGreaterThanOrEqual(2); // one per model turn
    expect(thoughts.some((e) => e.type === 'thinking' && e.agent === 'verifier')).toBe(true);
    // the streamed pieces of a call add up to the stored text
    const first = thoughts.find((e) => e.type === 'thinking' && !e.agent)!;
    const streamed = deltas.filter((d) => d.runId === run.id && d.nodeId === 'check' && d.key === 'main.1.1').map((d) => d.text).join('');
    expect(first.type === 'thinking' && streamed).toBe(first.type === 'thinking' ? first.text : '');
    expect(run.log!.some((e) => e.kind === 'thinking' && e.nodeId === 'check' && e.text.startsWith('思考：'))).toBe(true);
    expect(run.log!.some((e) => e.kind === 'thinking' && e.text.startsWith('核验代理思考：'))).toBe(true);
  });

  it('is off by default, and only roles that may see run internals can turn it on', async () => {
    const plain = await start('builder', { mode: 'production', inputs: { material: LOW_RISK_POST } });
    const done = await t.waitRun('builder', plain.body.id, ['succeeded', 'failed']);
    expect(done.options).toBeUndefined();
    expect(Object.values(done.nodes).flatMap((n) => n.transcript ?? []).some((e) => e.type === 'thinking')).toBe(false);

    const runner = await start('runner', { mode: 'production', inputs: { material: LOW_RISK_POST }, options: { showThinking: true } });
    expect(runner.body.options).toBeUndefined(); // ignored: reasoning may restate the task instructions
    const rd = await t.waitRun('runner', runner.body.id, ['succeeded', 'failed']);
    expect(rd.log!.some((e) => e.kind === 'thinking')).toBe(false);
  });

  it('never hands reasoning to viewers without run.view_internals (records or live events)', () => {
    const run = {
      nodes: { a: { nodeId: 'a', transcript: [{ type: 'thinking', turn: 1, text: 'x' }, { type: 'note', turn: 1, message: 'n' }], prompt: { system: 's', user: 'u' }, rawOutput: 'r' } },
      log: [{ seq: 1, at: '', kind: 'thinking', text: '思考：x' }, { seq: 2, at: '', kind: 'node', text: 'n' }],
    } as unknown as Run;
    const v = runForViewer(run, false);
    expect(v.nodes.a.transcript).toEqual([{ type: 'note', turn: 1, message: 'n' }]);
    expect(v.nodes.a.prompt).toBeUndefined();
    expect(v.log!.map((e) => e.kind)).toEqual(['node']);
    expect(runForViewer(run, true)).toBe(run);
    expect(eventForViewer({ type: 'thinking_delta', runId: 'r', nodeId: 'a', key: 'k', text: 't' }, false)).toBe(false);
    expect(eventForViewer({ type: 'transcript', runId: 'r', nodeId: 'a', entry: { type: 'thinking', turn: 1, text: 't' } }, false)).toBe(false);
    expect(eventForViewer({ type: 'log', runId: 'r', entry: { seq: 1, at: '', kind: 'thinking', text: 't' } }, false)).toBe(false);
    expect(eventForViewer({ type: 'log', runId: 'r', entry: { seq: 1, at: '', kind: 'node', text: 't' } }, false)).toBe(true);
  });

  it('adds the reasoning to a chat follow-up answer', async () => {
    const c = (await t.call<Conversation>('builder', 'POST', '/api/conversations', {})).body;
    const r = await t.call<ChatSendResult>('builder', 'POST', `/api/conversations/${c.id}/messages`, { mode: 'run', text: LOW_RISK_POST, workflowId: WF, thinking: true });
    expect(r.body.run!.options).toEqual({ showThinking: true });
    await t.waitRun('builder', r.body.run!.id, ['succeeded', 'failed']);
    const a = await t.call<ChatSendResult>('builder', 'POST', `/api/conversations/${c.id}/messages`, { mode: 'ask', text: '结论是什么？', thinking: true });
    const last = a.body.conversation.messages.at(-1)!;
    expect(last.role === 'assistant' && last.kind === 'answer' && last.thinking).toContain('模拟思考');
  });
});

describe('停止: stop a run or an answer', () => {
  it('stops a running run: model calls are interrupted, unfinished nodes skipped, results kept; it can continue from there', async () => {
    const r = await start('runner', { mode: 'production', inputs: { material: HIGH_RISK_EDM, channel: 'EDM' } });
    await until('runner', r.body.id, (x) => x.nodes.extract.status === 'succeeded' && x.nodes.check.status === 'running');
    expect((await t.call('builder', 'POST', `/api/runs/${r.body.id}/cancel`)).status).toBe(403); // can see it, but did not start it
    const stopped = await t.call<Run>('runner', 'POST', `/api/runs/${r.body.id}/cancel`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.canceled?.byName).toBeTruthy();
    const done = await until('runner', r.body.id, (x) => x.status === 'canceled', 5_000);
    expect(done.nodes.extract.status).toBe('succeeded'); // finished work is kept
    expect(done.nodes.check).toMatchObject({ status: 'skipped', skipReason: '运行已停止' });
    expect(done.error).toBeUndefined();
    expect(done.log!.at(-1)!.text).toContain('运行已停止');
    expect((await t.call('runner', 'POST', `/api/runs/${r.body.id}/cancel`)).status).toBe(409);
    expect(t.ctx.db.listAudit('org_demo', 50).some((e) => e.action === 'run.cancel' && e.entityId === r.body.id)).toBe(true);

    const cont = await t.call<Run>('runner', 'POST', `/api/runs/${r.body.id}/retry`);
    expect(cont.status).toBe(201);
    expect(cont.body.nodes.extract.reusedFrom).toBe(r.body.id);
    expect(cont.body.log![0].text).toContain('从停止处继续');
    const after = await t.waitRun('runner', cont.body.id, ['waiting_approval', 'succeeded', 'failed']);
    expect(after.nodes.check.status).toBe('succeeded');
  });

  it('stops a run that waits for approval at once; only the starter or an admin may stop', async () => {
    const r = await start('runner', { mode: 'production', inputs: { material: HIGH_RISK_EDM, channel: 'EDM' } });
    await t.waitRun('runner', r.body.id, ['waiting_approval']);
    expect((await t.call('reviewer', 'POST', `/api/runs/${r.body.id}/cancel`)).status).toBe(403);
    expect((await t.call('admin', 'POST', `/api/runs/${r.body.id}/cancel`)).status).toBe(200);
    const done = (await t.call<Run>('runner', 'GET', `/api/runs/${r.body.id}`)).body;
    expect(done.status).toBe('canceled');
    expect(done.nodes.legal_approval).toMatchObject({ status: 'skipped', skipReason: '运行已停止' });
    expect((await t.call('reviewer', 'POST', `/api/runs/${r.body.id}/nodes/legal_approval/decision`, { decision: 'approved' })).status).toBe(409); // nothing to approve any more
  });

  it('stops a follow-up answer being written', async () => {
    const c = (await t.call<Conversation>('runner', 'POST', '/api/conversations', {})).body;
    const r = await t.call<ChatSendResult>('runner', 'POST', `/api/conversations/${c.id}/messages`, { mode: 'run', text: LOW_RISK_POST, workflowId: WF });
    await t.waitRun('runner', r.body.run!.id, ['succeeded', 'failed']);
    expect((await t.call('runner', 'POST', `/api/conversations/${c.id}/cancel`)).status).toBe(409); // nothing to stop
    const asking = t.call<ChatSendResult>('runner', 'POST', `/api/conversations/${c.id}/messages`, { mode: 'ask', text: '解释一下结果' });
    await new Promise((x) => setTimeout(x, 80));
    expect((await t.call('runner', 'POST', `/api/conversations/${c.id}/cancel`)).status).toBe(200);
    const a = await asking;
    expect(a.status).toBe(200);
    expect(a.body.conversation.messages.at(-1)).toMatchObject({ role: 'assistant', kind: 'error', code: 'RUN_CANCELED', text: '已停止回答。' });
  });
});
