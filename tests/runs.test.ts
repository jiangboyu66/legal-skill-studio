import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedbackStats } from '../shared/feedback';
import { HIGH_RISK_EDM, LOW_RISK_POST } from '../server/seed/samples';
import type { Run } from '../shared/types';
import { startApp, type TestApp, WF } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
  await t.login('builder', 'runner', 'reviewer', 'reviewer2');
  await t.approveSeedRulePack();
});
afterAll(() => t.stop());

const start = (who: string, body: Record<string, unknown>) => t.call<Run>(who, 'POST', `/api/workflows/${WF}/runs`, body);

describe('retry from the failed node (T8)', () => {
  it('reuses successful nodes, keeps the original versions and drops fault injection', async () => {
    const r = await start('builder', { mode: 'test', inputs: { material: HIGH_RISK_EDM, channel: 'EDM' }, fault: { type: 'rate_limit', nodeId: 'check' } });
    const failed = await t.waitRun('builder', r.body.id);
    expect(failed.status).toBe('failed');
    expect(failed.nodes.extract.status).toBe('succeeded');
    expect(failed.nodes.check.error?.code).toBe('PROVIDER_RATE_LIMIT');

    const retry = await t.call<Run>('builder', 'POST', `/api/runs/${failed.id}/retry`);
    expect(retry.status).toBe(201);
    expect(retry.body.retryOf).toBe(failed.id);
    expect(retry.body.faultInjection).toBeUndefined();
    expect(retry.body.warnings[0].code).toBe('RETRY');
    expect(retry.body.nodes.extract.reusedFrom).toBe(failed.id);
    expect(['pending', 'running']).toContain(retry.body.nodes.check.status);
    const done = await t.waitRun('builder', retry.body.id);
    expect(['waiting_approval', 'succeeded']).toContain(done.status);
    expect(done.nodes.check.status).toBe('succeeded');
    expect(done.nodes.extract.output).toEqual(failed.nodes.extract.output);
    expect(done.skills).toEqual(failed.skills);
    // only the re-executed nodes count towards this run's usage
    const executed = Object.values(done.nodes).filter((n) => !n.reusedFrom);
    expect(done.usage.inputTokens).toBe(executed.reduce((s, n) => s + (n.usage?.inputTokens ?? 0), 0));
    expect(executed.map((n) => n.nodeId)).not.toContain('extract');

    expect((await t.call('builder', 'POST', `/api/runs/${done.id}/retry`)).status).toBe(409);
    expect((await t.call('runner', 'POST', `/api/runs/${failed.id}/retry`)).status).toBe(404); // not visible to the runner
  });
});

describe('jurisdiction is explicit or labelled as an assumption', () => {
  it('assumes the rule pack jurisdiction when none is given and shows it everywhere', async () => {
    const r = await start('runner', { mode: 'production', inputs: { material: LOW_RISK_POST } });
    expect(r.body.jurisdiction).toMatchObject({ value: '新加坡（SG）', assumed: true });
    const done = await t.waitRun('runner', r.body.id);
    const check = (await t.call<Run>('builder', 'GET', `/api/runs/${done.id}`)).body.nodes.check;
    expect(check.prompt!.system).toContain('jurisdiction: 新加坡（SG） (ASSUMED');
    const md = await t.call('runner', 'GET', `/api/runs/${done.id}/export?format=md`);
    expect(md.body).toContain('适用法域：新加坡（SG）（假设）');
  });

  it('uses an explicit choice and warns when it does not match the rule packs', async () => {
    const sg = await start('runner', { mode: 'production', inputs: { material: LOW_RISK_POST, jurisdiction: 'Singapore' } });
    expect(sg.body.jurisdiction).toMatchObject({ value: '新加坡（SG）', assumed: false });
    expect(sg.body.warnings.map((w) => w.code)).not.toContain('JURISDICTION_MISMATCH');
    const my = await start('runner', { mode: 'production', inputs: { material: LOW_RISK_POST, jurisdiction: '马来西亚' } });
    expect(my.body.jurisdiction).toMatchObject({ value: '马来西亚（MY）', assumed: false });
    expect(my.body.warnings.find((w) => w.code === 'JURISDICTION_MISMATCH')?.message).toContain('新加坡（SG）');
    await t.waitRun('runner', sg.body.id);
    await t.waitRun('runner', my.body.id);
  });
});

describe('reviewer feedback: accept / edit / reject / missed (H)', () => {
  it('records edits and missed issues, computes H and puts them in the report', async () => {
    const r = await start('runner', { mode: 'production', inputs: { material: HIGH_RISK_EDM, channel: 'EDM' } });
    const run = await t.waitRun('runner', r.body.id);
    const n = (run.nodes.check.output as { findings: unknown[] }).findings.length;
    expect(n).toBeGreaterThanOrEqual(3);
    const put = (location: string, decision: string | null, extra: Record<string, unknown> = {}) => t.call('reviewer', 'PUT', `/api/runs/${run.id}/reviews`, { nodeId: 'check', location, decision, ...extra });
    expect((await put('findings[0]', 'accepted')).status).toBe(200);
    expect((await put('findings[1]', 'edited', { edits: { risk_level: 'low', suggested_fix: '改为“深受用户喜爱”' }, note: '风险偏高' })).status).toBe(200);
    expect((await put('findings[2]', 'edited', { edits: {} })).status).toBe(400);
    const rej = await put('findings[2]', 'rejected', { note: '规则不适用' });
    expect(rej.body['check|findings[1]']).toMatchObject({ decision: 'edited', edits: { risk_level: 'low' }, note: '风险偏高' });

    const missed = await t.call('reviewer', 'POST', `/api/runs/${run.id}/missed`, { nodeId: 'check', ruleId: 'SCAP-05', quote: 'Dr. Tan', issue: '医生背书未核实' });
    expect(missed.status).toBe(201);
    expect((await t.call('reviewer', 'POST', `/api/runs/${run.id}/missed`, { nodeId: 'check', issue: '' })).status).toBe(400);
    expect((await t.call('reviewer', 'POST', `/api/runs/${run.id}/missed`, { nodeId: 'legal_approval', issue: 'x' })).status).toBe(400);

    const after = (await t.call<Run>('reviewer', 'GET', `/api/runs/${run.id}`)).body;
    const fb = feedbackStats(after, 'check');
    expect(fb).toMatchObject({ accepted: 1, edited: 1, rejected: 1, missed: 1, pending: n - 3 });
    expect(fb.h).toBeCloseTo(2 / (2 + 1 + 2), 5);
    const md = (await t.call('reviewer', 'GET', `/api/runs/${run.id}/export?format=md`)).body as string;
    expect(md).toContain('修改后采纳');
    expect(md).toContain('risk_level → low');
    expect(md).toContain('补充漏项（黄审核（法律审核人））：[SCAP-05] 医生背书未核实');
    expect(md).toContain('H = 0.40');

    const del = await t.call('reviewer', 'DELETE', `/api/runs/${run.id}/missed/${missed.body[0].id}`);
    expect(del.body).toEqual([]);
  });
});

describe('mock markers reproduce failure modes (T9–T12)', () => {
  const run = async (marker: string) => {
    const r = await start('builder', { mode: 'test', inputs: { material: `${LOW_RISK_POST}\n${marker}`, channel: 'Instagram' } });
    return t.waitRun('builder', r.body.id);
  };

  it('[[MOCK:429]] is retried automatically and then fails with a clear message', async () => {
    const r = await run('[[MOCK:429]]');
    expect(r.status).toBe('failed');
    expect(r.nodes.extract.error?.code).toBe('PROVIDER_RATE_LIMIT');
    expect(r.nodes.extract.error?.message).toContain('已自动重试 2 次');
    expect(r.nodes.extract.attempts).toBe(3);
  });

  it('[[MOCK:429_ONCE]] recovers through the automatic retry', async () => {
    const r = await run('[[MOCK:429_ONCE]]');
    expect(r.nodes.extract.status).toBe('succeeded');
    expect(r.nodes.extract.attempts).toBeGreaterThan(r.nodes.extract.turns!);
  });

  it('[[MOCK:TIMEOUT]] and [[MOCK:BAD_JSON]] fail with their own codes', async () => {
    expect((await run('[[MOCK:TIMEOUT]]')).nodes.extract.error?.code).toBe('PROVIDER_TIMEOUT');
    expect((await run('[[MOCK:BAD_JSON]]')).nodes.extract.error?.code).toBe('OUTPUT_SCHEMA_ERROR');
  });

  it('[[MOCK:FAKE_QUOTE]] produces an invented quote that grounding catches and verification prioritises', async () => {
    const material = `${HIGH_RISK_EDM}\n[[MOCK:FAKE_QUOTE]]`;
    const r = await start('builder', { mode: 'test', inputs: { material, channel: 'EDM' } });
    const done = await t.waitRun('builder', r.body.id);
    const check = done.nodes.check;
    const g = check.validation!.grounding.find((x) => x.path === 'findings[].quote')!;
    expect(g.items[0]).toMatchObject({ found: false });
    expect(check.verification!.items[0]).toMatchObject({ quoteFound: false, needsHumanReview: true });
    expect(done.finalNodeId ?? 'memo').toBeTruthy();
  });
});
