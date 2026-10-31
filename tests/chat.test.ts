import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HIGH_RISK_EDM, LOW_RISK_POST } from '../server/seed/samples';
import type { ChatSendResult, Conversation, ConversationSummary, Run, WorkflowView } from '../shared/types';
import { startApp, type TestApp, WF } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
  await t.login('builder', 'runner', 'reviewer', 'reviewer2');
  await t.approveSeedRulePack();
});
afterAll(() => t.stop());

const create = async (who: string, body: Record<string, unknown> = {}) => (await t.call<Conversation>(who, 'POST', '/api/conversations', body)).body;
const send = (who: string, id: string, body: Record<string, unknown>) => t.call<ChatSendResult & { error: { code: string; message: string } }>(who, 'POST', `/api/conversations/${id}/messages`, body);

describe('chat home: conversations', () => {
  it('starts a workflow run from pasted material, keeps the result in the thread and answers a follow-up', async () => {
    const c = await create('runner');
    expect(c.title).toBe('新对话');
    const r = await send('runner', c.id, { mode: 'run', text: LOW_RISK_POST, workflowId: WF, inputs: { channel: '社交媒体（Instagram）' } });
    expect(r.status).toBe(201);
    const run = r.body.run!;
    expect(run.mode).toBe('production');
    expect(run.inputs.channel).toBe('社交媒体（Instagram）');
    expect(run.documents.material).toMatch(/^doc_/); // pasted text is stored as the material document
    const conv = r.body.conversation;
    expect(conv.title.startsWith('Nimbus CloudRest')).toBe(true);
    expect(conv.messages.map((m) => (m.role === 'user' ? `user:${m.mode}` : `assistant:${m.kind}`))).toEqual(['user:run', 'assistant:run']);
    expect(conv.workflowId).toBe(WF);

    const done = await t.waitRun('runner', run.id, ['succeeded', 'failed', 'rejected']);
    expect(done.status).toBe('succeeded');

    const a = await send('runner', c.id, { mode: 'ask', text: '第 1 条为什么需要关注？' });
    expect(a.status).toBe(200);
    const last = a.body.conversation.messages.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', kind: 'answer', runId: run.id });
    if (last.role === 'assistant' && last.kind === 'answer') {
      expect(last.provider.mode).toBe('mock');
      expect(last.text).toContain('模拟模式回答');
      expect(last.text).toContain('第 1 条为什么需要关注');
    }
    // the stored conversation has the whole thread; the list shows a summary
    const stored = (await t.call<Conversation>('runner', 'GET', `/api/conversations/${c.id}`)).body;
    expect(stored.messages).toHaveLength(4);
    const list = (await t.call<ConversationSummary[]>('runner', 'GET', '/api/conversations')).body;
    expect(list[0]).toMatchObject({ id: c.id, messageCount: 4, runIds: [run.id] });
    const audit = t.ctx.db.listAudit('org_demo', 50);
    expect(audit.some((e) => e.action === 'conversation.ask' && e.entityId === run.id)).toBe(true);
  });

  it('uses an uploaded attachment as the material and the text as a note; re-runs with the same inputs', async () => {
    const up = await t.call('runner', 'POST', `/api/documents?filename=${encodeURIComponent('post.txt')}`, undefined, { raw: Buffer.from(LOW_RISK_POST) });
    expect(up.status).toBe(201);
    const c = await create('runner');
    const r = await send('runner', c.id, { mode: 'run', text: '请审阅这份材料。', workflowId: WF, attachments: [{ documentId: up.body.id }] });
    expect(r.status).toBe(201);
    expect(r.body.run!.documents.material).toBe(up.body.id);
    expect(r.body.conversation.title).toBe('post.txt');
    const user = r.body.conversation.messages[0];
    expect(user).toMatchObject({ role: 'user', text: '请审阅这份材料。', attachments: [{ documentId: up.body.id, filename: 'post.txt' }] });
    await t.waitRun('runner', r.body.run!.id, ['succeeded', 'failed']);

    const again = await send('runner', c.id, { mode: 'run', rerunOf: r.body.run!.id, text: '' });
    expect(again.status).toBe(201);
    expect(again.body.run!.rerunOf).toBe(r.body.run!.id);
    expect(again.body.run!.documents.material).toBe(up.body.id);
    expect(again.body.conversation.messages.filter((m) => m.role === 'assistant' && m.kind === 'run')).toHaveLength(2);
    await t.waitRun('runner', again.body.run!.id, ['succeeded', 'failed']);
  });

  it('rejects what cannot run, without storing anything', async () => {
    const c = await create('runner');
    const empty = await send('runner', c.id, { mode: 'run', text: '   ', workflowId: WF });
    expect(empty.status).toBe(400);
    const badDoc = await send('runner', c.id, { mode: 'run', text: 'x', workflowId: WF, attachments: [{ documentId: 'doc_missing' }] });
    expect(badDoc.status).toBe(400);
    const noRun = await send('runner', c.id, { mode: 'ask', text: '结果如何？' });
    expect(noRun.status).toBe(400);
    expect(noRun.body.error.message).toContain('还没有运行结果');

    // a draft (unpublished) workflow cannot be run from the chat
    const seed = (await t.call<WorkflowView>('builder', 'GET', `/api/workflows/${WF}`)).body;
    const draft = await t.call<WorkflowView>('builder', 'POST', '/api/workflows', { name: '未发布的副本', description: '', def: seed.draft });
    expect(draft.status).toBe(201);
    const bc = await create('builder');
    const unpublished = await send('builder', bc.id, { mode: 'run', text: LOW_RISK_POST, workflowId: draft.body.id });
    expect(unpublished.status).toBe(409);
    expect(unpublished.body.error.code).toBe('WORKFLOW_NOT_PUBLISHED');

    expect((await t.call<Conversation>('runner', 'GET', `/api/conversations/${c.id}`)).body.messages).toHaveLength(0);
  });

  it('does not answer follow-ups while the run is still open (waiting for approval)', async () => {
    const c = await create('runner');
    const r = await send('runner', c.id, { mode: 'run', text: HIGH_RISK_EDM, workflowId: WF, inputs: { channel: 'EDM' } });
    const waiting = await t.waitRun('runner', r.body.run!.id, ['waiting_approval', 'succeeded', 'failed']);
    expect(waiting.status).toBe('waiting_approval');
    const ask = await send('runner', c.id, { mode: 'ask', text: '有哪些高风险问题？' });
    expect(ask.status).toBe(409);
    expect(ask.body.error.code).toBe('RUN_NOT_FINISHED');
    // after the reviewer approves, the same run finishes and can be asked about
    const dec = await t.call('reviewer', 'POST', `/api/runs/${waiting.id}/nodes/legal_approval/decision`, { decision: 'approved', comment: '同意' });
    expect(dec.status).toBe(200);
    const done = await t.waitRun('runner', waiting.id, ['succeeded', 'failed', 'rejected']);
    expect(done.status).toBe('succeeded');
    const ok = await send('runner', c.id, { mode: 'ask', text: '第 2 条是什么问题？' });
    expect(ok.status).toBe(200);
    const answer = ok.body.conversation.messages.at(-1)!;
    // the memo is the final result; the numbered findings come from the rule-check step
    expect(answer.role === 'assistant' && answer.kind === 'answer' && answer.text).toMatch(/「对照规则检查」的结果中有 \d+ 条「findings」，你问到的是第 2 条/);
  });

  it('keeps conversations private, renames and deletes them (runs stay)', async () => {
    const c = await create('runner');
    const r = await send('runner', c.id, { mode: 'run', text: LOW_RISK_POST, workflowId: WF });
    await t.waitRun('runner', r.body.run!.id, ['succeeded', 'failed']);
    expect((await t.call('builder', 'GET', `/api/conversations/${c.id}`)).status).toBe(404);
    expect((await send('builder', c.id, { mode: 'ask', text: 'hi' })).status).toBe(404);
    expect((await t.call<ConversationSummary[]>('builder', 'GET', '/api/conversations')).body.some((x) => x.id === c.id)).toBe(false);

    const renamed = await t.call<Conversation>('runner', 'PATCH', `/api/conversations/${c.id}`, { title: '  社媒帖复核  ' });
    expect(renamed.body.title).toBe('社媒帖复核');
    expect((await t.call('runner', 'PATCH', `/api/conversations/${c.id}`, { title: ' ' })).status).toBe(400);
    expect((await t.call('runner', 'DELETE', `/api/conversations/${c.id}`)).status).toBe(200);
    expect((await t.call('runner', 'GET', `/api/conversations/${c.id}`)).status).toBe(404);
    expect((await t.call<Run>('runner', 'GET', `/api/runs/${r.body.run!.id}`)).status).toBe(200);
  });

  it('encrypts conversations at rest like runs', async () => {
    const enc = await startApp({ config: { dataEncryptionKey: randomBytes(32).toString('base64') } });
    try {
      await enc.login('runner', 'reviewer');
      await enc.approveSeedRulePack();
      const c = (await enc.call<Conversation>('runner', 'POST', '/api/conversations', {})).body;
      await enc.call('runner', 'POST', `/api/conversations/${c.id}/messages`, { mode: 'run', text: LOW_RISK_POST, workflowId: WF });
      const probe = enc.ctx.db.encryptionProbe();
      expect(probe.readable).toBe(true);
      const raw = (enc.ctx.db as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => { data: string } } } }).db.prepare('SELECT data FROM conversations WHERE id = ?').get(c.id);
      expect(raw.data.startsWith('enc:v1:')).toBe(true);
      expect(raw.data).not.toContain('Nimbus');
    } finally {
      await enc.stop();
    }
  });
});
