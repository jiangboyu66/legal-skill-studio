/**
 * QueryEngine (agent main loop), tool permissions, hooks, layered prompts and legal-conclusion verification.
 */
import { describe, expect, it } from 'vitest';
import { SKILL_RUNNER } from '../server/core/agents';
import { HookRunner } from '../server/core/hooks';
import { buildSystemPrompt, renderPrompt } from '../server/core/prompt';
import { QueryEngine, type QueryEngineConfig } from '../server/core/queryEngine';
import { TOOL_REGISTRY } from '../server/core/tools';
import { verifyFindings } from '../server/core/verification';
import type { Block, CompletionRequest, CompletionResult, LLMProvider } from '../server/services/llm/types';
import type { MaterialDocument, OutputField, Rule, VerificationConfig } from '../shared/types';

const doc: MaterialDocument = {
  id: 'doc_test',
  orgId: 'org',
  filename: 'edm.pdf',
  mime: 'application/pdf',
  kind: 'pdf',
  size: 1,
  sha256: '',
  status: 'ready',
  method: 'text-layer',
  pages: [
    { n: 1, text: "Nimbus is Singapore's No.1 mattress.\nClinically proven to cure back pain in 7 nights." },
    { n: 2, text: 'Reply with your NRIC number to join the lucky draw.\nWe will also send deals via SMS.' },
  ],
  warnings: [],
  uploadedBy: 'u',
  createdAt: '',
};
const rules = new Map<string, Rule & { packName: string }>([
  ['SCAP-04', { id: 'SCAP-04', title: 'Substantiation', text: 'Claims must be substantiated.', severity: 'medium', source: { title: 'SCAP', verification: 'paraphrased' }, packName: 'P' }],
  ['NRIC-01', { id: 'NRIC-01', title: 'NRIC collection', text: 'Do not collect NRIC numbers for lucky draws.', severity: 'high', source: { title: 'PDPC', verification: 'verbatim', excerpt: '...' }, packName: 'P' }],
  ['PDPA-02', { id: 'PDPA-02', title: 'DNC registry', text: 'Check the DNC registry before sending marketing SMS / calls.', severity: 'high', source: { title: 'PDPA', verification: 'paraphrased' }, appliesTo: { channels: ['sms', 'voice', 'messaging'] }, packName: 'P' }],
]);
const fields: OutputField[] = [
  { key: 'findings', type: 'object_list', required: true, fields: [{ key: 'rule_id', type: 'string', required: true }, { key: 'quote', type: 'string', required: true }, { key: 'risk', type: 'enum', options: ['high', 'medium', 'low'], required: true }] },
  { key: 'overall', type: 'enum', options: ['high', 'medium', 'low'], required: true },
];

/** Provider that replays scripted responses and records every request. */
class Scripted implements LLMProvider {
  info = { name: 'anthropic' as const, model: 'scripted', mode: 'real' as const, vision: false };
  capabilities = { tools: true, vision: false, pdf: false, promptCache: true };
  requests: CompletionRequest[] = [];
  constructor(private script: (Partial<CompletionResult> & { content: Block[] })[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    return { model: 'scripted', stopReason: next.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end', usage: { inputTokens: 100, outputTokens: 10 }, ...next };
  }
}
const use = (name: string, input: unknown, id = `tu_${name}_${Math.random().toString(36).slice(2, 6)}`): Block => ({ type: 'tool_use', id, name, input });
const good = { findings: [{ rule_id: 'NRIC-01', quote: 'Reply with your NRIC number', risk: 'HIGH' }], overall: 'high' };

function engine(provider: LLMProvider, extra: Partial<QueryEngineConfig> = {}) {
  return new QueryEngine({
    provider,
    system: [{ text: 'SYS', cache: true }, { text: 'CTX' }],
    tools: TOOL_REGISTRY,
    toolContext: { documents: { material: doc }, rules, inputs: {} },
    outputFields: fields,
    useTools: true,
    canUseTool: () => 'allow',
    grantedTools: [],
    maxTurns: 6,
    maxTokens: 1000,
    retry: { maxRetries: 0, baseMs: 1 },
    ...extra,
  });
}
const userTurn: Block[] = [{ type: 'text', text: 'check it' }];

describe('agent loop', () => {
  it('executes tools, returns tool results to the model and accepts a valid submit_output', async () => {
    const p = new Scripted([
      { content: [{ type: 'text', text: 'Let me search.' }, use('search_document', { query: 'NRIC' }, 'tu_1'), use('lookup_rule', { rule_ids: ['NRIC-01', 'NOPE-1'] }, 'tu_2')] },
      { content: [use('submit_output', good, 'tu_3')] },
    ]);
    const r = await engine(p).run(userTurn);
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ findings: [{ rule_id: 'NRIC-01', quote: 'Reply with your NRIC number', risk: 'high' }], overall: 'high' });
    expect(r.turns).toBe(2);
    expect(r.usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
    const second = p.requests[1].messages;
    const results = second[second.length - 1].content as Extract<Block, { type: 'tool_result' }>[];
    expect(results.map((b) => b.toolUseId)).toEqual(['tu_1', 'tu_2']);
    expect(results[0].content).toContain('page 2');
    expect(results[1].content).toContain('Do not collect NRIC numbers');
    expect(results[1].content).toContain('NOPE-1');
    expect(p.requests[0].tools!.map((t) => t.name)).toContain('submit_output');
    expect(r.transcript.map((e) => e.type)).toEqual(['assistant_text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result']);
  });

  it('rejects schema-invalid submissions with actionable errors, and gives up after three', async () => {
    const p = new Scripted([{ content: [use('submit_output', { findings: [{ rule_id: 'X' }] })] }, { content: [use('submit_output', good)] }]);
    const r = await engine(p).run(userTurn);
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    const fb = p.requests[1].messages.at(-1)!.content[0] as Extract<Block, { type: 'tool_result' }>;
    expect(fb.isError).toBe(true);
    expect(fb.content).toMatch(/quote|overall/);

    const bad = new Scripted([0, 1, 2].map(() => ({ content: [use('submit_output', { nope: 1 })] })));
    const r2 = await engine(bad).run(userTurn);
    expect(r2.error!.code).toBe('OUTPUT_SCHEMA_ERROR');
  });

  it('applies tool permissions: deny returns an error to the model, ask pauses for a human, granted proceeds', async () => {
    const denied = new Scripted([{ content: [use('lookup_rule', { rule_ids: ['NRIC-01'] })] }, { content: [use('submit_output', good)] }]);
    const r = await engine(denied, { canUseTool: (t) => (t === 'lookup_rule' ? 'deny' : 'allow') }).run(userTurn);
    expect(r.ok).toBe(true);
    expect((denied.requests[1].messages.at(-1)!.content[0] as { content: string }).content).toContain('not permitted');

    const ask = new Scripted([{ content: [use('lookup_rule', { rule_ids: ['NRIC-01'] })] }]);
    const r2 = await engine(ask, { canUseTool: (t) => (t === 'lookup_rule' ? 'ask' : 'allow') }).run(userTurn);
    expect(r2.ok).toBe(false);
    expect(r2.permissionRequest).toMatchObject({ tool: 'lookup_rule' });
    expect(r2.error!.code).toBe('PERMISSION_REQUIRED');

    const granted = new Scripted([{ content: [use('lookup_rule', { rule_ids: ['NRIC-01'] })] }, { content: [use('submit_output', good)] }]);
    const r3 = await engine(granted, { canUseTool: () => 'ask', grantedTools: ['lookup_rule'] }).run(userTurn);
    expect(r3.ok).toBe(true);
  });

  it('runs PreToolUse hooks that can block a tool, and validates tool input', async () => {
    const hooks = new HookRunner().register({ name: 'no-search', event: 'PreToolUse', matcher: 'search_document', description: '', run: () => ({ block: 'searching is disabled' }) });
    const p = new Scripted([{ content: [use('search_document', { query: 'x' }), use('read_document', { from_page: 'one' })] }, { content: [use('submit_output', good)] }]);
    const r = await engine(p, { hooks }).run(userTurn);
    expect(r.ok).toBe(true);
    const res = p.requests[1].messages.at(-1)!.content as { content: string; isError?: boolean }[];
    expect(res[0].content).toContain('no-search: searching is disabled');
    expect(res[1]).toMatchObject({ isError: true });
    expect(res[1].content).toContain('invalid input');
  });

  it('stops on refusal, truncation, max turns and budget', async () => {
    expect((await engine(new Scripted([{ content: [{ type: 'text', text: 'no' }], stopReason: 'refusal' }])).run(userTurn)).error!.code).toBe('MODEL_REFUSED');
    expect((await engine(new Scripted([{ content: [{ type: 'text', text: '{"a":' }], stopReason: 'max_tokens' }])).run(userTurn)).error!.code).toBe('OUTPUT_TRUNCATED');
    const loop = new Scripted(Array.from({ length: 3 }, () => ({ content: [use('search_document', { query: 'x' })] })));
    expect((await engine(loop, { maxTurns: 3 }).run(userTurn)).error!.code).toBe('MAX_TURNS');
    const pricey = new Scripted([{ content: [use('search_document', { query: 'x' })] }, { content: [use('submit_output', good)] }]);
    const r = await engine(pricey, { budgetUsd: 0.001, priceFn: (u) => ((u.inputTokens ?? 0) * 10) / 1e6 }).run(userTurn);
    expect(r.error!.code).toBe('BUDGET_EXCEEDED');
  });

  it('falls back to JSON-in-text with one repair round when tools are unavailable', async () => {
    const p = new Scripted([{ content: [{ type: 'text', text: 'Here you go: not json' }] }, { content: [{ type: 'text', text: '```json\n' + JSON.stringify(good) + '\n```' }] }]);
    const r = await engine(p, { useTools: false, tools: [] }).run(userTurn);
    expect(r).toMatchObject({ ok: true, repaired: true, turns: 2 });
    expect(p.requests[0].tools).toBeUndefined();
  });
});

describe('layered system prompt', () => {
  it('orders platform → agent → organisation → skill, marks the static prefix cacheable, keeps run context dynamic', () => {
    const blocks = buildSystemPrompt({
      agent: SKILL_RUNNER,
      orgInstructions: 'Use British spelling.',
      skill: { name: 'Rule check', instructions: 'Check the rules.', rules: '[R-1] rule', output: 'Call submit_output.' },
      dynamic: { date: '2026-10-31', channel: 'EDM', empty: undefined },
    });
    expect(blocks).toHaveLength(4);
    expect(blocks[0].text).toContain('# Agent: skill-runner');
    expect(blocks[1].text).toContain('Use British spelling.');
    expect(blocks[2]).toMatchObject({ cache: true });
    expect(blocks[2].text).toContain('[R-1] rule');
    expect(blocks[3].cache).toBeUndefined();
    expect(blocks[3].text).toContain('- channel: EDM');
    expect(blocks[3].text).not.toContain('empty');
    expect(renderPrompt(blocks, 'u').system).toContain('动态内容边界');
  });
});

describe('legal conclusion verification', () => {
  const config: VerificationConfig = { enabled: true, listPath: 'findings', ruleIdField: 'rule_id', quoteField: 'quote', conclusionField: 'issue', severityField: 'risk', channelInput: 'channel', useAgent: true };
  const output = {
    findings: [
      { rule_id: 'NRIC-01', quote: 'Reply with your NRIC number', issue: 'Collects NRIC for a lucky draw', risk: 'high' },
      { rule_id: 'SCAP-99', quote: "Singapore's No.1 mattress", issue: 'Unsubstantiated superlative', risk: 'medium' },
      { rule_id: 'SCAP-04', quote: 'cures all back pain forever', issue: 'Health claim', risk: 'high' },
      { rule_id: 'PDPA-02', quote: 'We will also send deals via SMS', issue: 'Must check DNC registry', risk: 'high' },
      { rule_id: 'SCAP-04', quote: 'Clinically proven to cure back pain in 7 nights', issue: 'Health claim needs evidence', risk: 'low' },
    ],
  };
  const material = { text: doc.pages.map((p) => p.text).join('\n'), doc };

  it('runs deterministic checks: rule exists, quote on page, channel scope, severity consistency', async () => {
    const r = await verifyFindings({ output, config, rules, material, channel: 'Instagram post' });
    const [a, b, c, d, e] = r.items;
    expect(a).toMatchObject({ ruleExists: true, quoteFound: true, page: 2, applicability: 'ok', severity: 'ok', needsHumanReview: false, verdict: 'not_checked' });
    expect(b).toMatchObject({ ruleExists: false, needsHumanReview: true });
    expect(c).toMatchObject({ quoteFound: false, needsHumanReview: true });
    expect(d).toMatchObject({ applicability: 'warn', needsHumanReview: true });
    expect(d.applicabilityNote).toContain('social');
    expect(e).toMatchObject({ severity: 'ok', page: 1 });
    expect(r.summary).toMatchObject({ not_checked: 5, flagged: 3 });
    expect(r.agentUsed).toBe(false);
  });

  it('merges verdicts from the verifier agent; doubtful verdicts require human review', async () => {
    const r = await verifyFindings({
      output,
      config,
      rules,
      material,
      channel: 'SMS',
      runAgent: async (items) =>
        items.map((x) => ({ index: x.index, verdict: x.index === 4 ? 'needs_facts' : 'supported', reason: 'ok', missing_facts: x.index === 4 ? ['临床研究报告'] : [] })),
    });
    expect(r.agentUsed).toBe(true);
    expect(r.items[3]).toMatchObject({ applicability: 'ok', verdict: 'supported', needsHumanReview: false });
    expect(r.items[4]).toMatchObject({ verdict: 'needs_facts', needsHumanReview: true, missingFacts: ['临床研究报告'] });
    expect(r.summary).toMatchObject({ supported: 4, needs_facts: 1 });
  });

  it('degrades gracefully when the verifier agent fails', async () => {
    const r = await verifyFindings({ output, config, rules, material, runAgent: async () => null });
    expect(r.agentUsed).toBe(false);
    expect(r.note).toContain('确定性检查');
    expect(r.items[3]).toMatchObject({ applicability: 'unknown' });
  });
});
