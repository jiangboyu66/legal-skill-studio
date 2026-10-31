import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOW_RISK_POST } from '../server/seed/samples';
import { hashPassword } from '../server/services/auth';
import type { Run, SkillView, WorkflowView } from '../shared/types';
import { SKILL_CHECK, startApp, type TestApp, WF } from './helpers';

/** 使用者 (runner) only use published workflows: no review area, no drafts, no authoring internals. */
let t: TestApp;
beforeAll(async () => {
  t = await startApp();
  await t.login('admin', 'builder', 'reviewer', 'runner');
  await t.approveSeedRulePack();
});
afterAll(() => t.stop());

describe('使用者 scope', () => {
  it('has no access to the review area; authors, reviewers and admins do', async () => {
    const me = (await t.call('runner', 'GET', '/api/auth/me')).body;
    expect(me.can['review.view']).toBe('deny');
    expect(me.can['run.view_internals']).toBe('deny');
    expect((await t.call('runner', 'GET', '/api/reviews')).status).toBe(403);
    for (const who of ['builder', 'reviewer', 'admin']) expect((await t.call(who, 'GET', '/api/reviews')).status).toBe(200);
    const req = (await t.call('reviewer', 'GET', '/api/reviews')).body.requests[0];
    expect((await t.call('runner', 'GET', `/api/reviews/${req.id}`)).status).toBe(403);
    expect((await t.call('builder', 'GET', `/api/reviews/${req.id}`)).status).toBe(200);
  });

  it('sees published skills only, without task instructions, notes, samples or unpublished drafts', async () => {
    const created = await t.call<SkillView>('builder', 'POST', '/api/skills', { name: '草稿中的 Skill', description: '尚未发布', config: { instructions: '内部任务说明', inputs: [{ key: 'material', label: '物料', type: 'long_text', required: true }], output: { format: 'markdown', fields: [] } } });
    expect(created.status).toBe(201);
    const list = (await t.call<SkillView[]>('runner', 'GET', '/api/skills')).body;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => s.publishedVersion)).toBe(true);
    expect(list.map((s) => s.id)).not.toContain(created.body.id);
    expect((await t.call('runner', 'GET', `/api/skills/${created.body.id}`)).status).toBe(404);
    expect((await t.call<SkillView[]>('builder', 'GET', '/api/skills')).body.map((s) => s.id)).toContain(created.body.id);

    // an unpublished edit to a published skill stays invisible to 使用者
    const full = (await t.call<SkillView>('builder', 'GET', `/api/skills/${SKILL_CHECK}`)).body;
    expect(full.draft.instructions.length).toBeGreaterThan(20);
    await t.call('builder', 'PUT', `/api/skills/${SKILL_CHECK}`, { ...full, description: '草稿里的新描述', config: { ...full.draft, instructions: `${full.draft.instructions}\nDRAFT-ONLY` } });
    const seen = (await t.call<SkillView>('runner', 'GET', `/api/skills/${SKILL_CHECK}`)).body;
    expect(seen.draft.instructions).toBe('');
    expect(seen.published!.instructions).toBe('');
    expect(seen.draft.knowledge).toBe('');
    expect(seen.draft.testCases).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('DRAFT-ONLY');
    expect(seen.draft.inputs).toEqual(full.published!.inputs);
    expect(seen.dirty).toBe(false);
    expect(seen.usedBy.map((w) => w.id)).toEqual([WF]);

    expect((await t.call('runner', 'GET', `/api/skills/${SKILL_CHECK}/export`)).status).toBe(403);
    expect((await t.call('builder', 'GET', `/api/skills/${SKILL_CHECK}/export`)).status).toBe(200);
    expect((await t.call('reviewer', 'GET', `/api/skills/${SKILL_CHECK}`)).body.draft.instructions).toContain('DRAFT-ONLY');
  });

  it('sees published workflows only, as published (no draft, no pins)', async () => {
    const draft = await t.call<WorkflowView>('builder', 'POST', '/api/workflows', { name: '未发布的工作流', description: '', def: { inputs: [{ key: 'material', label: '物料', type: 'document', required: true }], nodes: [] } });
    expect(draft.status).toBe(201);
    const list = (await t.call<WorkflowView[]>('runner', 'GET', '/api/workflows')).body;
    expect(list.map((w) => w.id)).toEqual([WF]);
    expect((await t.call('runner', 'GET', `/api/workflows/${draft.body.id}`)).status).toBe(404);
    const wf = (await t.call<WorkflowView>('runner', 'GET', `/api/workflows/${WF}`)).body;
    expect(wf.draft).toEqual(wf.published && { ...wf.published, pins: undefined });
    expect(wf.draft).not.toHaveProperty('pins');
    expect((await t.call('runner', 'GET', `/api/workflows/${WF}/versions/1`)).status).toBe(403);
  });

  it('gets runs without prompts or raw model output; authors and reviewers see them', async () => {
    const r = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: LOW_RISK_POST, channel: 'Instagram' } });
    expect(r.status).toBe(201);
    const done = await t.waitRun('runner', r.body.id);
    expect(done.status).toBe('succeeded');
    const nodes = Object.values(done.nodes).filter((n) => n.type === 'skill' && n.status === 'succeeded');
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.prompt).toBeUndefined();
      expect(n.rawOutput).toBeUndefined();
      expect(n.output).toBeDefined();
    }
    const json = await t.call('runner', 'GET', `/api/runs/${done.id}/export?format=json`);
    expect(JSON.stringify(json.body)).not.toContain('"prompt"');
    const asBuilder = (await t.call<Run>('builder', 'GET', `/api/runs/${done.id}`)).body;
    expect(asBuilder.nodes.check.prompt?.system.length).toBeGreaterThan(0);
    expect((await t.call<Run>('reviewer', 'GET', `/api/runs/${done.id}`)).body.nodes.check.rawOutput).toBeDefined();
  });
});

describe('upgrade from v3.0 test accounts', () => {
  it('moves accounts still on the old shared password to their own password; changed ones are kept', async () => {
    const first = await startApp();
    const { db } = first.ctx;
    for (const email of ['admin@demo.local', 'runner@demo.local']) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { passwordHash, ...u } = db.getUserByEmail(email)!;
      db.putUser(u, hashPassword(email === 'admin@demo.local' ? 'demo1234' : 'My-own-pass-1'));
    }
    const dataDir = first.dataDir;
    await first.stop();

    const second = await startApp({ dataDir });
    try {
      expect(second.checks.find((c) => c.name === 'demo-passwords')?.message).toContain('1 个测试账号');
      const login = (email: string, password: string) => second.call(email, 'POST', '/api/auth/login', { email, password });
      expect((await login('admin@demo.local', 'demo1234')).status).toBe(401);
      expect((await login('admin@demo.local', 'Admin@2026')).status).toBe(200);
      expect((await login('runner@demo.local', 'My-own-pass-1')).status).toBe(200);
      const accounts = (await second.call('x', 'GET', '/api/auth/demo-accounts')).body.accounts as { email: string; password?: string; passwordChanged?: boolean }[];
      expect(accounts.find((a) => a.email === 'admin@demo.local')).toMatchObject({ password: 'Admin@2026', passwordChanged: false });
      expect(accounts.find((a) => a.email === 'runner@demo.local')).toMatchObject({ passwordChanged: true });
    } finally {
      await second.stop();
    }
  });
});
