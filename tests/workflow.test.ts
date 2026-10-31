/**
 * DAG workflows: conditions, branches, parallel nodes, human approval nodes, coalesce mappings,
 * failure propagation and resume after restart (fix for "linear steps only, no branches / parallel / approval").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateWorkflowDef } from '../server/core/workflow/dag';
import { evaluate, referencedNodes } from '../server/core/workflow/expr';
import { HIGH_RISK_EDM, LOW_RISK_POST } from '../server/seed/samples';
import { MockProvider } from '../server/services/llm/mock';
import type { CompletionRequest, LLMProvider } from '../server/services/llm/types';
import type { Run, SkillConfig, WorkflowDef } from '../shared/types';
import { startApp, type TestApp } from './helpers';

describe('condition expressions', () => {
  const ctx = {
    inputs: { channel: 'EDM（批量营销邮件）' },
    nodes: {
      check: { status: 'succeeded', output: { overall_risk: 'high', findings: [{ risk_level: 'high' }, { risk_level: 'low' }] } },
      gate: { status: 'succeeded', decision: 'approved' },
    },
  };
  it('evaluates comparisons, boolean logic and helper functions', () => {
    expect(evaluate('nodes.check.output.overall_risk == "high"', ctx)).toBe(true);
    expect(evaluate('len(nodes.check.output.findings) > 1 && !(inputs.channel == "SMS")', ctx)).toBe(true);
    expect(evaluate('count(nodes.check.output.findings, "risk_level", "high") >= 2', ctx)).toBe(false);
    expect(evaluate('any(nodes.check.output.findings, "risk_level", "low") || false', ctx)).toBe(true);
    expect(evaluate('contains(inputs.channel, "EDM")', ctx)).toBe(true);
    expect(evaluate('nodes.gate.decision == "approved"', ctx)).toBe(true);
    expect(evaluate('nodes.missing.output.x == null', ctx)).toBe(true);
    expect(evaluate("nodes.check.output.findings[1].risk_level == 'low'", ctx)).toBe(true);
  });
  it('rejects unsafe or malformed expressions instead of evaluating code', () => {
    expect(() => evaluate('exit(1)', ctx)).toThrow(/不支持的函数/);
    expect(() => evaluate('process.exit(1)', ctx)).toThrow();
    expect(() => evaluate('constructor.constructor("return 1")()', ctx)).toThrow();
    expect(() => evaluate('nodes.check.output.overall_risk = "high"', ctx)).toThrow();
    expect(() => evaluate('a ==', ctx)).toThrow(/不完整/);
    expect(referencedNodes('nodes.a.output.x == 1 || len(nodes.b.output) > 0')).toEqual(['a', 'b']);
  });
});

describe('static validation', () => {
  const cfg: SkillConfig = {
    instructions: 'x',
    knowledge: '',
    rulePackIds: [],
    inputs: [{ key: 'text', label: '文本', type: 'long_text', required: true }],
    output: { format: 'json', fields: [{ key: 'risk', type: 'enum', options: ['high', 'low'], required: true }] },
    checks: [],
    tools: [],
    testCases: [],
  };
  const lookup = () => ({ name: 'S', config: cfg });
  const node = (id: string, needs: string[], extra: object = {}) => ({ id, name: id, type: 'skill' as const, skillId: 's', needs, mappings: { text: { type: 'literal' as const, value: 'x' } }, ...extra });
  const errors = (def: WorkflowDef) => validateWorkflowDef(def, lookup).filter((i) => i.level === 'error').map((i) => i.message);

  it('detects cycles, unknown dependencies and conditions that look at non-upstream nodes', () => {
    expect(errors({ inputs: [], nodes: [node('a', ['b']), node('b', ['a'])] })[0]).toContain('循环');
    expect(errors({ inputs: [], nodes: [node('a', ['zzz'])] })[0]).toContain('不存在');
    const e = errors({ inputs: [], nodes: [node('a', []), node('b', [], { when: 'nodes.a.output.risk == "high"' })] });
    expect(e[0]).toContain('不在该节点的上游');
  });
  it('checks mappings, approval nodes and output fields', () => {
    const e = errors({
      inputs: [],
      nodes: [
        node('a', []),
        node('b', ['a'], { mappings: { text: { type: 'node_output', nodeId: 'a', path: 'nope' } } }),
        node('c', [], { mappings: { text: { type: 'node_output', nodeId: 'a' } } }),
        { id: 'gate', name: 'gate', type: 'approval', needs: ['a'], instructions: '', showNodeIds: ['b'], approverRole: 'reviewer', onReject: 'stop' },
      ],
    });
    expect(e.some((m) => m.includes('「nope」'))).toBe(true);
    expect(e.some((m) => m.includes('不在上游'))).toBe(true);
    expect(e.some((m) => m.includes('要展示的节点「b」不在其上游'))).toBe(true);
  });
});

/** Mock model with latency that records how many calls are in flight at once. */
class ProbeProvider implements LLMProvider {
  inner = new MockProvider(0);
  info = this.inner.info;
  capabilities = this.inner.capabilities;
  inflight = 0;
  max = 0;
  async complete(req: CompletionRequest) {
    this.inflight++;
    this.max = Math.max(this.max, this.inflight);
    try {
      await new Promise((r) => setTimeout(r, 40));
      return await this.inner.complete(req);
    } finally {
      this.inflight--;
    }
  }
}

describe('DAG execution', () => {
  let t: TestApp;
  const probe = new ProbeProvider();
  let wfId = '';

  beforeAll(async () => {
    t = await startApp({ provider: probe });
    await t.login('admin', 'builder', 'reviewer', 'runner');
    const assess = await t.call('builder', 'POST', '/api/skills', {
      name: '风险评估',
      config: {
        instructions: 'Assess the overall risk of the material.',
        inputs: [{ key: 'material', label: '材料', type: 'document', required: true }],
        output: { format: 'json', fields: [{ key: 'risk', label: '风险', type: 'enum', options: ['high', 'medium', 'low'], required: true }, { key: 'items', type: 'object_list', required: true, fields: [{ key: 'quote', type: 'string', required: true }] }] },
        checks: [{ label: '引文', path: 'items[].quote', source: 'input:material' }],
        tools: ['read_document', 'search_document'],
      },
    });
    const note = await t.call('builder', 'POST', '/api/skills', {
      name: '备注',
      config: { instructions: 'Write a short note about the text.', inputs: [{ key: 'text', label: '文本', type: 'long_text', required: true }], output: { format: 'markdown' } },
    });
    expect(assess.status).toBe(201);
    const s = (id: string, needs: string[], text: object, extra: object = {}) => ({ id, name: id, type: 'skill', skillId: note.body.id, needs, mappings: { text }, ...extra });
    const def = {
      inputs: [{ key: 'material', label: '材料', type: 'document', required: true }],
      nodes: [
        { id: 'a', name: 'A 评估', type: 'skill', skillId: assess.body.id, needs: [], mappings: { material: { type: 'workflow_input', key: 'material' } } },
        s('p1', ['a'], { type: 'node_output', nodeId: 'a', path: 'risk' }),
        s('p2', ['a'], { type: 'node_output', nodeId: 'a', path: 'items' }),
        s('hi', ['a'], { type: 'literal', value: 'HIGH BRANCH' }, { when: 'nodes.a.output.risk == "high"' }),
        { id: 'gate', name: '人工审批', type: 'approval', needs: ['p1', 'p2'], when: 'nodes.a.output.risk != "low"', instructions: '请审批', showNodeIds: ['a', 'p1'], approverRole: 'reviewer', onReject: 'stop' },
        s('final', ['gate', 'hi'], { type: 'coalesce', options: [{ type: 'node_output', nodeId: 'hi' }, { type: 'literal', value: 'NO-HIGH-BRANCH' }] }),
      ],
      outputNodeId: 'final',
    };
    const wf = await t.call('builder', 'POST', '/api/workflows', { name: 'DAG 测试', def });
    expect(wf.body.issues).toEqual([]);
    wfId = wf.body.id;
  });
  afterAll(() => t.stop());

  const start = async (who: string, material: string, extra: object = {}) => {
    const r = await t.call<Run>(who, 'POST', `/api/workflows/${wfId}/runs`, { mode: 'test', inputs: { material }, ...extra });
    expect(r.status).toBe(201);
    return t.waitRun(who, r.body.id);
  };

  it('low risk: skips the high-risk branch and the approval gate, runs p1 ∥ p2 in parallel, coalesce falls back', async () => {
    probe.max = 0;
    const run = await start('builder', LOW_RISK_POST);
    expect(run.status).toBe('succeeded');
    const st = Object.fromEntries(run.order.map((id) => [id, run.nodes[id].status]));
    expect(st).toEqual({ a: 'succeeded', p1: 'succeeded', p2: 'succeeded', hi: 'skipped', gate: 'skipped', final: 'succeeded' });
    expect(run.nodes.hi.skipReason).toContain('条件不满足');
    expect(probe.max).toBeGreaterThanOrEqual(2);
    expect(run.nodes.final.resolvedInputs!.text).toBe('NO-HIGH-BRANCH');
    expect(run.nodes.p1.resolvedInputs!.text).toBe('low');
    expect(run.nodes.a.validation!.grounding[0].passed).toBe(run.nodes.a.validation!.grounding[0].total);
    expect(typeof run.finalOutput).toBe('string');
  });

  it('high risk: runs the branch, pauses at the approval node, and continues after approval with the branch output', async () => {
    const paused = await start('admin', HIGH_RISK_EDM);
    expect(paused.status).toBe('waiting_approval');
    expect(paused.nodes.hi.status).toBe('succeeded');
    expect(paused.nodes.gate.approvalRequest).toMatchObject({ approverRole: 'reviewer', instructions: '请审批' });
    expect(paused.nodes.final.status).toBe('pending');
    // four-eyes on runs: the starter cannot approve; the builder lacks the permission
    expect((await t.call('admin', 'POST', `/api/runs/${paused.id}/nodes/gate/decision`, { decision: 'approved' })).status).toBe(403);
    expect((await t.call('builder', 'POST', `/api/runs/${paused.id}/nodes/gate/decision`, { decision: 'approved' })).status).toBe(403);
    const ok = await t.call('reviewer', 'POST', `/api/runs/${paused.id}/nodes/gate/decision`, { decision: 'approved', comment: '可以' });
    expect(ok.status).toBe(200);
    const done = await t.waitRun('admin', paused.id, ['succeeded', 'failed', 'rejected']);
    expect(done.status).toBe('succeeded');
    expect(done.nodes.gate.approval).toMatchObject({ decision: 'approved', byName: '黄审核（法律审核人）', comment: '可以' });
    expect(done.nodes.final.resolvedInputs!.text).toContain('模拟模式');
    expect((await t.call('reviewer', 'POST', `/api/runs/${paused.id}/nodes/gate/decision`, { decision: 'approved' })).status).toBe(409);
  });

  it('rejection at a stop gate ends the run as rejected and skips the rest', async () => {
    const paused = await start('admin', HIGH_RISK_EDM);
    expect((await t.call('reviewer', 'POST', `/api/runs/${paused.id}/nodes/gate/decision`, { decision: 'rejected' })).status).toBe(400);
    await t.call('reviewer', 'POST', `/api/runs/${paused.id}/nodes/gate/decision`, { decision: 'rejected', comment: '证据不足' });
    const done = await t.waitRun('admin', paused.id, ['succeeded', 'failed', 'rejected']);
    expect(done.status).toBe('rejected');
    expect(done.nodes.gate.status).toBe('rejected');
    expect(done.nodes.final).toMatchObject({ status: 'skipped' });
    expect(done.finalOutput).toBeUndefined();
  });

  it('a failing node fails the run, downstream nodes are skipped, and the error names the node', async () => {
    const run = await start('builder', LOW_RISK_POST, { fault: { type: 'auth', nodeId: 'p2' } });
    expect(run.status).toBe('failed');
    expect(run.nodes.p2.error!.code).toBe('PROVIDER_AUTH');
    expect(run.nodes.final.status).toBe('skipped');
    expect(run.error!.message).toContain('节点「p2」失败');
    expect(run.warnings).toEqual([]);
  });

  it('retries transient errors and records the attempts', async () => {
    const run = await start('builder', LOW_RISK_POST, { fault: { type: 'rate_limit', nodeId: 'p1' } });
    expect(run.status).toBe('failed');
    expect(run.nodes.p1.error!.code).toBe('PROVIDER_RATE_LIMIT');
    expect(run.nodes.p1.error!.message).toContain('已自动重试 2 次');
  });

  it('missing required inputs are rejected before the run starts', async () => {
    const r = await t.call('builder', 'POST', `/api/workflows/${wfId}/runs`, { mode: 'test', inputs: {} });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'MISSING_INPUT' });
  });

  it('re-runs with the same inputs (and documents) after the workflow is edited', async () => {
    const first = await start('builder', LOW_RISK_POST);
    const wf = (await t.call('builder', 'GET', `/api/workflows/${wfId}`)).body;
    const def = structuredClone(wf.draft);
    def.nodes.find((n: { id: string }) => n.id === 'p1').name = 'P1（已修改）';
    await t.call('builder', 'PUT', `/api/workflows/${wfId}`, { ...wf, def });
    const again = await t.call<Run>('builder', 'POST', `/api/runs/${first.id}/rerun`, {});
    const done = await t.waitRun('builder', again.body.id);
    expect(done.rerunOf).toBe(first.id);
    expect(done.nodes.p1.name).toBe('P1（已修改）');
    expect(done.documents.material).toBe(first.documents.material);
  });
});

describe('resume after restart', () => {
  it('re-executes nodes that were running when the process stopped', async () => {
    const t1 = await startApp();
    await t1.login('builder');
    const wfId = 'wf_demo_sg_marketing_review';
    const r = await t1.call<Run>('builder', 'POST', `/api/workflows/${wfId}/runs`, { mode: 'test', inputs: { material: LOW_RISK_POST } });
    const done = await t1.waitRun('builder', r.body.id);
    expect(done.status).toBe('succeeded');
    // simulate a crash while the last node was executing
    const crashed: Run = { ...done, status: 'running', finishedAt: undefined, finalOutput: undefined };
    crashed.nodes = { ...done.nodes, memo: { ...done.nodes.memo, status: 'running', output: undefined } };
    t1.ctx.db.runs.put(crashed);
    await t1.stop();

    const t2 = await startApp({ dataDir: t1.dataDir });
    await t2.login('builder');
    const resumed = await t2.waitRun('builder', r.body.id, ['succeeded', 'failed']);
    expect(resumed.status).toBe('succeeded');
    expect(resumed.warnings.map((w) => w.code)).toContain('RESUMED');
    expect(resumed.nodes.memo.status).toBe('succeeded');
    expect(typeof resumed.finalOutput).toBe('string');
    await t2.stop();
  });
});

describe('sequential mode', () => {
  it('runs one node at a time when PARALLEL_NODES is off', async () => {
    const probe = new ProbeProvider();
    const t = await startApp({ provider: probe, config: { featureOverrides: '-PARALLEL_NODES' } });
    await t.login('builder');
    const r = await t.call<Run>('builder', 'POST', '/api/workflows/wf_demo_sg_marketing_review/runs', { mode: 'test', inputs: { material: HIGH_RISK_EDM } });
    const run = await t.waitRun('builder', r.body.id);
    expect(run.nodes.deep_review.status).toBe('succeeded');
    expect(run.nodes.evidence_request.status).toBe('succeeded');
    expect(probe.max).toBe(1);
    await t.stop();
  });
});
