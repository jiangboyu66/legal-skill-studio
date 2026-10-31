/**
 * Accounts, permissions, publish approval, rule-pack governance and org isolation (fixes for
 * "single user, local JSON, no accounts / permissions / publish approval" and "rule pack not reviewed").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrg } from '../server/seed';
import { HIGH_RISK_EDM, LOW_RISK_POST } from '../server/seed/samples';
import type { Run, SkillView } from '../shared/types';
import { RULE_PACK, SKILL_CHECK, startApp, type TestApp, WF } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
  await t.login('admin', 'builder', 'reviewer', 'reviewer2', 'runner');
});
afterAll(() => t.stop());

describe('authentication', () => {
  it('rejects anonymous calls, wrong passwords and requests without the CSRF header', async () => {
    expect((await t.call('nobody', 'GET', '/api/skills')).status).toBe(401);
    const bad = await t.call('x', 'POST', '/api/auth/login', { email: 'runner@demo.local', password: 'wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('LOGIN_FAILED');
    const noCsrf = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'runner@demo.local', password: 'Runner@2026' }) });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).error.code).toBe('CSRF_BLOCKED');
  });

  it('returns the current user with effective permissions; logout ends the session', async () => {
    const me = await t.call('runner', 'GET', '/api/auth/me');
    expect(me.body.user.role).toBe('runner');
    expect(me.body.can['workflow.run']).toBe('allow');
    expect(me.body.can['skill.edit']).toBe('deny');
    expect(me.body.can['rulepack.approve']).toBe('deny');
    // a second session for the same user, then log it out
    const other = await t.call('runner2', 'POST', '/api/auth/login', { email: 'runner@demo.local', password: 'Runner@2026' });
    expect(other.status).toBe(200);
    await t.call('runner2', 'POST', '/api/auth/logout');
    expect((await t.call('runner2', 'GET', '/api/auth/me')).status).toBe(401);
    expect((await t.call('runner', 'GET', '/api/auth/me')).status).toBe(200);
  });

  it('locks out repeated failed logins for 10 minutes', async () => {
    for (let i = 0; i < 5; i++) expect((await t.call('x', 'POST', '/api/auth/login', { email: 'nobody@demo.local', password: 'guess' })).status).toBe(401);
    const locked = await t.call('x', 'POST', '/api/auth/login', { email: 'nobody@demo.local', password: 'guess' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('lists one test account per role, each with its own password; login still needs the password', async () => {
    const r = await t.call('nobody', 'GET', '/api/auth/demo-accounts');
    const accounts = r.body.accounts as { email: string; role: string; password?: string }[];
    expect(accounts.map((a) => a.role)).toEqual(['admin', 'builder', 'reviewer', 'reviewer', 'runner']);
    expect(new Set(accounts.map((a) => a.password)).size).toBe(5);
    expect(r.body).not.toHaveProperty('password');
    expect((await t.call('x2', 'POST', '/api/auth/login', { email: 'builder@demo.local', password: 'Runner@2026' })).status).toBe(401);
    // a password changed by the admin is no longer published
    await t.call('admin', 'PATCH', '/api/admin/users/usr_reviewer2', { password: 'Changed-Pass-9' });
    const after = (await t.call('nobody', 'GET', '/api/auth/demo-accounts')).body.accounts.find((a: { email: string }) => a.email === 'reviewer2@demo.local');
    expect(after).toMatchObject({ passwordChanged: true });
    expect(after.password).toBeUndefined();
    await t.call('admin', 'PATCH', '/api/admin/users/usr_reviewer2', { password: 'Reviewer2@2026' });
  });
});

describe('role permissions', () => {
  it('runners can view and run but not edit; builders cannot approve', async () => {
    expect((await t.call('runner', 'GET', '/api/skills')).status).toBe(200);
    const create = await t.call('runner', 'POST', '/api/skills', { name: 'x', config: {} });
    expect(create.status).toBe(403);
    expect(create.body.error.message).toContain('编辑 Skill 草稿');
    const inbox = await t.call('builder', 'GET', '/api/reviews');
    const req = inbox.body.requests.find((r: { entityType: string }) => r.entityType === 'rulepack');
    expect(req.canDecide).toBe(false);
    const decide = await t.call('builder', 'POST', `/api/reviews/${req.id}/decide`, { decision: 'approved' });
    expect(decide.status).toBe(403);
    expect((await t.call('runner', 'GET', '/api/admin/users')).status).toBe(403);
    expect((await t.call('runner', 'GET', '/api/admin/audit')).status).toBe(403);
  });
});

describe('rule pack governance', () => {
  it('blocks production runs until a legal reviewer approves the rule pack with an attestation', async () => {
    const pack = await t.call('runner', 'GET', `/api/rulepacks/${RULE_PACK}`);
    expect(pack.body.status).toBe('in_review');
    expect(pack.body.stats).toMatchObject({ total: 18 });
    expect(pack.body.stats.unverified).toBeGreaterThan(0);

    const blocked = await t.call('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: LOW_RISK_POST } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RULEPACK_NOT_APPROVED');

    const inbox = await t.call('reviewer', 'GET', '/api/reviews');
    const req = inbox.body.requests.find((r: { entityType: string }) => r.entityType === 'rulepack');
    const noAttest = await t.call('reviewer', 'POST', `/api/reviews/${req.id}/decide`, { decision: 'approved' });
    expect(noAttest.body.error.code).toBe('ATTESTATION_REQUIRED');
    const tooFar = await t.call('reviewer', 'POST', `/api/reviews/${req.id}/decide`, {
      decision: 'approved',
      attestation: { approverName: 'A', approverQualification: 'B', attested: true, reviewDueAt: '2035-01-01' },
    });
    expect(tooFar.status).toBe(400);

    expect((await t.approveSeedRulePack()).status).toBe(200);
    const approved = await t.call('runner', 'GET', `/api/rulepacks/${RULE_PACK}`);
    expect(approved.body).toMatchObject({ status: 'approved', approvedVersion: 1, dirty: false });
    expect(approved.body.approval).toMatchObject({ approverName: 'Demo Reviewer', approverQualification: '演示账号（非真实执业律师）' });

    const ok = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: LOW_RISK_POST, channel: 'Instagram' } });
    expect(ok.status).toBe(201);
    expect(ok.body.rulePacks[0]).toMatchObject({ version: 1, status: 'approved' });
    const done = await t.waitRun('runner', ok.body.id);
    expect(done.status).toBe('succeeded');
  });

  it('expired approvals block production runs again', async () => {
    const pack = t.ctx.db.rulePacks.get('org_demo', RULE_PACK)!;
    t.ctx.db.rulePacks.put({ ...pack, approval: { ...pack.approval!, reviewDueAt: '2020-01-01T00:00:00.000Z' } });
    const r = await t.call('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: LOW_RISK_POST } });
    expect(r.body.error.code).toBe('RULEPACK_EXPIRED');
    expect((await t.call('runner', 'GET', `/api/rulepacks/${RULE_PACK}`)).body.status).toBe('expired');
    t.ctx.db.rulePacks.put(pack);
  });

  it('pseudonymises NRIC / phone numbers before any model call and restores them in the result (S4)', async () => {
    const material = `${LOW_RISK_POST}\nWinner contact: S1234567D, tel +65 9123 4567. Clinically proven, today only!`;
    const r = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material } });
    const w = r.body.warnings.find((x) => x.code === 'PII_PSEUDONYMIZED')!.message;
    expect(w).toContain('NRIC/FIN 1 处');
    expect(w).toContain('电话号码 1 处');
    expect(w).not.toContain('1234567');
    const done = await t.waitRun('runner', r.body.id, ['waiting_approval', 'succeeded', 'failed']);
    // 使用者 do not get prompts or raw model output; authors and reviewers do
    expect(done.nodes.check.prompt).toBeUndefined();
    expect(done.nodes.check.rawOutput).toBeUndefined();
    const check = (await t.call<Run>('reviewer', 'GET', `/api/runs/${done.id}`)).body.nodes.check;
    // what the model saw: placeholders only
    expect(check.prompt!.user).toContain('[NRIC_1]');
    expect(check.prompt!.user).toContain('[PHONE_1]');
    expect(check.prompt!.user).not.toContain('S1234567D');
    expect(check.prompt!.user).not.toContain('9123 4567');
    expect(check.security?.pseudonymized).toContain('NRIC/FIN ×1');
    // what the reviewer sees: originals restored, and quotes still verify against the material
    const quotes = JSON.stringify(check.output);
    expect(quotes).not.toContain('[NRIC_1]');
    if (quotes.includes('S1234567D')) expect(check.validation!.grounding[0].passed).toBeGreaterThan(0);
    expect(JSON.stringify(done)).not.toMatch(/\[(NRIC|PHONE)_\d+\]"/);
  });

  it('test runs of drafts are allowed for builders, flagged as unreviewed when the pack has draft changes', async () => {
    const pack = (await t.call('builder', 'GET', `/api/rulepacks/${RULE_PACK}`)).body;
    const content = { ...pack.draft, rules: [...pack.draft.rules, { id: 'INT-99', title: 'Internal: no emojis in subject lines', text: 'House style.', severity: 'low', source: { title: 'Internal style guide', verification: 'unverified' } }] };
    const saved = await t.call('builder', 'PUT', `/api/rulepacks/${RULE_PACK}`, { ...pack, content });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: 'approved', dirty: true });
    const test = await t.call<Run>('builder', 'POST', `/api/workflows/${WF}/runs`, { mode: 'test', inputs: { material: LOW_RISK_POST } });
    expect(test.status).toBe(201);
    expect(test.body.rulePacks[0].version).toBe('draft');
    expect(test.body.warnings.map((w) => w.code)).toContain('RULEPACK_UNREVIEWED');
    expect((await t.call('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'test', inputs: { material: LOW_RISK_POST } })).status).toBe(403);
    // production still uses the approved version
    const prod = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: LOW_RISK_POST } });
    expect(prod.body.rulePackContents[RULE_PACK].rules.some((r) => r.id === 'INT-99')).toBe(false);
    await t.waitRun('builder', test.body.id);
    await t.waitRun('runner', prod.body.id);
  });

  it('validates rule content (ids, sources, verbatim excerpts)', async () => {
    const r = await t.call('builder', 'POST', '/api/rulepacks', { name: '内部规则', content: { rules: [{ id: 'bad id', title: '', text: 'x', source: { title: '', verification: 'verbatim' } }] } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('RULEPACK_INVALID');
    expect(r.body.error.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('publish approval for skills and workflows', () => {
  it('draft → in review (locked) → approved as an immutable new version used by production runs', async () => {
    const s = (await t.call<SkillView>('builder', 'GET', `/api/skills/${SKILL_CHECK}`)).body;
    expect(s).toMatchObject({ status: 'published', publishedVersion: 1, dirty: false });
    const config = { ...s.draft, instructions: `${s.draft.instructions}\n\nAlways mention the rule category.` };
    const saved = await t.call<SkillView>('builder', 'PUT', `/api/skills/${SKILL_CHECK}`, { ...s, config });
    expect(saved.body).toMatchObject({ status: 'published', dirty: true });

    const sub = await t.call('builder', 'POST', `/api/skills/${SKILL_CHECK}/submit`, { note: '补充输出要求' });
    expect(sub.body.status).toBe('pending');
    const locked = await t.call('builder', 'PUT', `/api/skills/${SKILL_CHECK}`, { ...s, config });
    expect(locked.status).toBe(409);
    expect((await t.call('builder', 'POST', `/api/skills/${SKILL_CHECK}/submit`, {})).status).toBe(409);

    const detail = await t.call('reviewer', 'GET', `/api/reviews/${sub.body.id}`);
    expect(detail.body.currentVersion).toBe(1);
    expect(detail.body.request.snapshot.instructions).toContain('rule category');
    const ok = await t.call('reviewer', 'POST', `/api/reviews/${sub.body.id}/decide`, { decision: 'approved', comment: 'LGTM' });
    expect(ok.status).toBe(200);
    const after = (await t.call<SkillView>('runner', 'GET', `/api/skills/${SKILL_CHECK}`)).body;
    expect(after).toMatchObject({ status: 'published', publishedVersion: 2, dirty: false });
    expect(after.versions.at(-1)).toMatchObject({ version: 2, approvedByName: '黄审核（法律审核人）', submittedBy: 'usr_builder' });
    expect((await t.call('builder', 'GET', `/api/skills/${SKILL_CHECK}/versions/1`)).body.instructions).not.toContain('rule category');
    expect((await t.call('runner', 'GET', `/api/skills/${SKILL_CHECK}/versions/1`)).status).toBe(403);

    // The published workflow pinned v1: publishing skill v2 does not silently change it.
    const pinned = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: LOW_RISK_POST } });
    expect(pinned.body.skills[SKILL_CHECK].version).toBe(1);
    expect(pinned.body.warnings.map((w) => w.code)).toContain('SKILL_UPDATE_AVAILABLE');
    const wfView = (await t.call('builder', 'GET', `/api/workflows/${WF}`)).body;
    expect(wfView.pinInfo.find((p: { skillId: string }) => p.skillId === SKILL_CHECK)).toMatchObject({ pinned: 1, latest: 2 });
    expect(wfView.dirty).toBe(false);
    await t.waitRun('runner', pinned.body.id);

    // Upgrading = re-submitting the workflow; the reviewer approves the new pins.
    const wsub = await t.call('builder', 'POST', `/api/workflows/${WF}/submit`, { note: '升级 rule-check 到 v2' });
    expect(wsub.status).toBe(200);
    const wdetail = await t.call('reviewer', 'GET', `/api/reviews/${wsub.body.id}`);
    expect(wdetail.body.request.snapshot.pins[SKILL_CHECK]).toBe(2);
    expect((await t.call('reviewer', 'POST', `/api/reviews/${wsub.body.id}/decide`, { decision: 'approved' })).status).toBe(200);
    const run = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: LOW_RISK_POST } });
    expect(run.body.skills[SKILL_CHECK].version).toBe(2);
    expect(run.body.warnings.map((w) => w.code)).not.toContain('SKILL_UPDATE_AVAILABLE');
    await t.waitRun('runner', run.body.id);
  });

  it('enforces four-eyes: the submitter cannot approve their own request', async () => {
    const s = (await t.call<SkillView>('admin', 'GET', `/api/skills/${SKILL_CHECK}`)).body;
    await t.call('admin', 'PUT', `/api/skills/${SKILL_CHECK}`, { ...s, description: `${s.description}（管理员修改）`, config: s.draft });
    const sub = await t.call('admin', 'POST', `/api/skills/${SKILL_CHECK}/submit`, {});
    const own = await t.call('admin', 'POST', `/api/reviews/${sub.body.id}/decide`, { decision: 'approved' });
    expect(own.status).toBe(403);
    expect(own.body.error.hint).toContain('四眼原则');
    const rej = await t.call('reviewer', 'POST', `/api/reviews/${sub.body.id}/decide`, { decision: 'rejected' });
    expect(rej.status).toBe(400); // a reason is required
    expect((await t.call('reviewer', 'POST', `/api/reviews/${sub.body.id}/decide`, { decision: 'rejected', comment: '描述不清' })).body.status).toBe('rejected');
    expect((await t.call<SkillView>('admin', 'GET', `/api/skills/${SKILL_CHECK}`)).body.publishedVersion).toBe(2);
  });

  it('unpublished workflows cannot run in production; publishing a workflow needs published skills', async () => {
    const created = await t.call('builder', 'POST', '/api/skills', {
      name: '新 Skill',
      config: { instructions: 'Summarise the material.', inputs: [{ key: 'material', label: '材料', type: 'document', required: true }], output: { format: 'markdown' } },
    });
    expect(created.status).toBe(201);
    const wf = await t.call('builder', 'POST', '/api/workflows', {
      name: '新工作流',
      def: {
        inputs: [{ key: 'material', label: '材料', type: 'document', required: true }],
        nodes: [{ id: 'summary', type: 'skill', name: '摘要', needs: [], skillId: created.body.id, mappings: { material: { type: 'workflow_input', key: 'material' } } }],
      },
    });
    expect(wf.body.issues).toEqual([]);
    const prod = await t.call('runner', 'POST', `/api/workflows/${wf.body.id}/runs`, { mode: 'production', inputs: { material: 'x' } });
    expect(prod.body.error.code).toBe('WORKFLOW_NOT_PUBLISHED');
    const sub = await t.call('builder', 'POST', `/api/workflows/${wf.body.id}/submit`, {});
    const blocked = await t.call('reviewer', 'POST', `/api/reviews/${sub.body.id}/decide`, { decision: 'approved' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('新 Skill');
  });
});

describe('organisation policy (allow / ask / deny)', () => {
  it('deny rules override roles; "ask" pauses an agent tool call until a reviewer grants it', async () => {
    const policy = (await t.call('admin', 'GET', '/api/auth/me')).body.org.policy;
    const lockout = await t.call('admin', 'PUT', '/api/admin/policy', { ...policy, permissions: { allow: [], ask: [], deny: ['admin.*'] } });
    expect(lockout.status).toBe(400);

    await t.call('admin', 'PUT', '/api/admin/policy', { ...policy, permissions: { allow: [], ask: [], deny: ['workflow.run'] } });
    expect((await t.call('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: HIGH_RISK_EDM } })).status).toBe(403);

    await t.call('admin', 'PUT', '/api/admin/policy', { ...policy, permissions: { allow: [], ask: ['tool:lookup_rule'], deny: [] } });
    const run = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: HIGH_RISK_EDM, channel: 'EDM' } });
    const paused = await t.waitRun('runner', run.body.id);
    expect(paused.status).toBe('waiting_approval');
    expect(paused.nodes.check.approvalRequest).toMatchObject({ tool: 'lookup_rule', approverRole: 'reviewer' });
    expect(paused.nodes.check.transcript!.some((e) => e.type === 'permission' && e.decision === 'ask')).toBe(true);

    const inbox = await t.call('reviewer', 'GET', '/api/reviews');
    expect(inbox.body.nodeApprovals.find((a: { runId: string }) => a.runId === run.body.id)).toMatchObject({ nodeId: 'check', tool: 'lookup_rule', canDecide: true });
    const granted = await t.call('reviewer', 'POST', `/api/runs/${run.body.id}/nodes/check/decision`, { decision: 'approved', comment: '允许查规则' });
    expect(granted.status).toBe(200);
    const next = await t.waitRun('runner', run.body.id);
    expect(next.grantedTools).toEqual(['lookup_rule']);
    expect(next.nodes.check.status).toBe('succeeded');
    expect(next.nodes.check.transcript!.some((e) => e.type === 'tool_call' && e.name === 'lookup_rule')).toBe(true);
    await t.call('admin', 'PUT', '/api/admin/policy', policy);
    // finish the run (legal approval node) so later tests start clean
    if (next.status === 'waiting_approval') await t.call('reviewer', 'POST', `/api/runs/${run.body.id}/nodes/legal_approval/decision`, { decision: 'rejected', comment: '测试结束' });
  });
});

describe('isolation and visibility', () => {
  it('another organisation cannot see or run this organisation’s content', async () => {
    createOrg(t.ctx.db, {
      id: 'org_other',
      name: 'Other Co',
      users: [{ id: 'usr_other', email: 'admin@other.local', name: 'Other Admin', role: 'admin', title: '' }],
      password: 'other-pass-1',
      plugins: [],
    });
    const login = await t.call('other', 'POST', '/api/auth/login', { email: 'admin@other.local', password: 'other-pass-1' });
    expect(login.status).toBe(200);
    expect((await t.call('other', 'GET', '/api/workflows')).body).toEqual([]);
    expect((await t.call('other', 'GET', `/api/workflows/${WF}`)).status).toBe(404);
    expect((await t.call('other', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: {} })).status).toBe(404);
    const someRun = (await t.call('runner', 'GET', '/api/runs')).body[0];
    expect((await t.call('other', 'GET', `/api/runs/${someRun.id}`)).status).toBe(404);
    expect((await t.call('other', 'GET', '/api/runs')).body).toEqual([]);
  });

  it('runners only see their own runs; reviewers see all', async () => {
    const own = (await t.call('runner', 'GET', '/api/runs')).body as { startedByName: string }[];
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.startedByName.startsWith('张使用'))).toBe(true);
    const all = (await t.call('reviewer', 'GET', '/api/runs')).body as { startedByName: string }[];
    expect(all.some((r) => r.startedByName.startsWith('林创建'))).toBe(true);
    const builderRun = all.find((r) => r.startedByName.startsWith('林创建')) as unknown as { id: string };
    expect((await t.call('runner', 'GET', `/api/runs/${builderRun.id}`)).status).toBe(404);
  });
});

describe('administration and audit', () => {
  it('admins manage users; disabling a user ends their sessions; admins cannot lock themselves out', async () => {
    const created = await t.call('admin', 'POST', '/api/admin/users', { email: 'new@demo.local', name: '新同事', role: 'runner', password: 'longpassword' });
    expect(created.status).toBe(201);
    await t.call('newbie', 'POST', '/api/auth/login', { email: 'new@demo.local', password: 'longpassword' });
    expect((await t.call('newbie', 'GET', '/api/auth/me')).status).toBe(200);
    await t.call('admin', 'PATCH', `/api/admin/users/${created.body.id}`, { disabled: true });
    expect((await t.call('newbie', 'GET', '/api/auth/me')).status).toBe(401);
    expect((await t.call('admin', 'PATCH', '/api/admin/users/usr_admin', { role: 'runner' })).status).toBe(400);
  });

  it('records an audit trail of approvals, runs and policy changes', async () => {
    const audit = (await t.call('reviewer', 'GET', '/api/admin/audit')).body as { action: string; userName?: string }[];
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ['rulepack.approve', 'skill.publish', 'skill.reject', 'run.start', 'run.succeeded', 'run.tool_approved', 'admin.policy_update', 'auth.login']) expect(actions).toContain(a);
    expect(audit.find((a) => a.action === 'rulepack.approve')?.userName).toBe('黄审核（法律审核人）');
  });
});
