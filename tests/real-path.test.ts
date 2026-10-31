/**
 * The whole seeded workflow through the *real* Anthropic adapter, pointed at a local fake Messages API
 * that behaves like a tool-using model (thinking blocks, tool calls, submit_output, a schema slip,
 * enum casing). Verifies the production path end to end without an API key.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AnthropicProvider } from '../server/services/llm/anthropic';
import { HIGH_RISK_EDM } from '../server/seed/samples';
import type { Run } from '../shared/types';
import { startApp, type TestApp, WF } from './helpers';

type Msg = { role: string; content: any };
const calls: { skill: string; turn: number; body: any; headers: http.IncomingHttpHeaders }[] = [];
let server: http.Server;
let t: TestApp;

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

function respond(body: any): { content: unknown[]; stop_reason: string } {
  const system = (body.system as { text: string }[]).map((s) => s.text).join('\n');
  const skill = /# Agent: verifier/.test(system) ? 'verifier' : (/# Skill: (.+)/.exec(system)?.[1] ?? '?');
  const messages = body.messages as Msg[];
  const turn = messages.filter((m) => m.role === 'assistant').length;
  calls.push({ skill, turn, body, headers: {} });
  const thinking = { type: 'thinking', thinking: `planning ${skill} turn ${turn}`, signature: `sig-${turn}` };
  const id = `toolu_${skill.length}_${turn}`;

  switch (skill) {
    case '营销声明提取':
      if (turn === 0) return { content: [thinking, toolUse(id, 'search_document', { query: 'NRIC' })], stop_reason: 'tool_use' };
      return {
        content: [
          toolUse(id, 'submit_output', {
            summary: 'Mattress sale EDM.',
            claims: [
              { quote: "Nimbus CloudRest is Singapore's No.1 mattress", claim_type: 'superlative', substantiation_needed: '市场份额数据' },
              { quote: 'clinically proven to cure back pain in just 7 nights', claim_type: 'efficacy_or_health', substantiation_needed: '临床研究' },
              { quote: 'Simply reply with your full name, NRIC number and mobile number', claim_type: 'personal_data_collection', substantiation_needed: '无' },
            ],
          }),
        ],
        stop_reason: 'tool_use',
      };
    case '新加坡营销合规规则检查': {
      if (turn === 0) return { content: [thinking, { type: 'text', text: 'Checking rule scope first.' }, toolUse(id, 'lookup_rule', { rule_ids: ['NRIC-01', 'SCAP-04'] })], stop_reason: 'tool_use' };
      const findings = [
        { rule_id: 'NRIC-01', quote: 'Simply reply with your full name, NRIC number and mobile number', issue: '抽奖收集 NRIC 号码', risk_level: 'High', suggested_fix: '删除 NRIC 收集', needs_human_review: false },
        { rule_id: 'SCAP-04', quote: 'clinically proven to cure back pain in just 7 nights', issue: '健康功效声明缺乏证明', risk_level: 'HIGH', suggested_fix: '删除或提供临床证据', needs_human_review: true },
      ];
      // first submission forgets overall_risk → the engine rejects it with the schema error; the model fixes it
      if (turn === 1) return { content: [toolUse(id, 'submit_output', { findings })], stop_reason: 'tool_use' };
      return { content: [toolUse(id, 'submit_output', { findings, overall_risk: 'high' })], stop_reason: 'tool_use' };
    }
    case 'verifier':
      if (turn === 0) return { content: [toolUse(id, 'lookup_rule', { rule_ids: ['NRIC-01'] })], stop_reason: 'tool_use' };
      return {
        content: [
          toolUse(id, 'submit_output', {
            items: [
              { index: 0, verdict: 'supported', reason: '规则明确禁止为抽奖收集 NRIC。', missing_facts: [] },
              { index: 1, verdict: 'needs_facts', reason: '需要确认是否有临床研究支持。', missing_facts: ['临床研究报告'] },
            ],
          }),
        ],
        stop_reason: 'tool_use',
      };
    case '高风险深度审查':
      return {
        content: [
          toolUse(id, 'submit_output', {
            summary: '两项高风险问题需升级。',
            escalations: [{ rule_id: 'NRIC-01', quote: 'NRIC number', why_high_risk: 'PDPC 指引', evidence_needed: '无', recommended_action: '删除' }],
            needs_external_counsel: false,
          }),
        ],
        stop_reason: 'tool_use',
      };
    default:
      return { content: [thinking, { type: 'text', text: `## ${skill}\n\n总体风险：high。\n\n> 本意见为 AI 生成的初审草稿，须经法务复核后使用。` }], stop_reason: 'end_turn' };
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const r = respond(body);
      calls[calls.length - 1].headers = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, ...r, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 800 } }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = new AnthropicProvider({ apiKey: 'sk-fake', model: 'claude-sonnet-5-5', baseUrl: base, version: '2023-06-01', effort: '', timeoutMs: 5000, promptCache: true, vision: true });
  t = await startApp({ provider, config: { priceInputPerMTok: 3, priceOutputPerMTok: 15 } });
  await t.login('runner', 'reviewer');
  await t.approveSeedRulePack();
});
afterAll(async () => {
  await t.stop();
  await new Promise<void>((ok) => server.close(() => ok()));
});

it('runs the seeded DAG workflow through the Anthropic adapter with tool use, verification and approval', async () => {
  const started = await t.call<Run>('runner', 'POST', `/api/workflows/${WF}/runs`, { mode: 'production', inputs: { material: HIGH_RISK_EDM, channel: 'EDM（批量营销邮件）' } });
  expect(started.status).toBe(201);
  const paused = await t.waitRun('runner', started.body.id);
  expect(paused.provider).toMatchObject({ name: 'anthropic', mode: 'real' });
  expect(paused.status).toBe('waiting_approval');

  // every call: key from env-style config, API version, cached static prefix, tools declared
  expect(calls.every((c) => c.headers['x-api-key'] === 'sk-fake' && c.headers['anthropic-version'] === '2023-06-01')).toBe(true);
  expect(calls.every((c) => c.body.system.some((s: { cache_control?: unknown }) => s.cache_control))).toBe(true);
  expect(calls.every((c) => !('temperature' in c.body))).toBe(true);

  // the check skill: thinking replayed on the next turn, tool_result returned, schema slip repaired, enum case normalised
  const check = calls.filter((c) => c.skill === '新加坡营销合规规则检查');
  expect(check).toHaveLength(3);
  expect(check[1].body.messages[1].content[0]).toMatchObject({ type: 'thinking', signature: 'sig-0' });
  const askedId = check[1].body.messages[1].content.find((b: { type: string }) => b.type === 'tool_use').id;
  expect(check[1].body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: askedId });
  expect(check[1].body.messages[2].content[0].content).toContain('NRIC-01');
  const slip = check[2].body.messages.at(-1).content[0];
  expect(slip).toMatchObject({ type: 'tool_result', is_error: true });
  expect(slip.content).toContain('overall_risk');
  const node = paused.nodes.check;
  expect(node.validation!.repaired).toBe(true);
  expect((node.output as { findings: { risk_level: string }[] }).findings.map((f) => f.risk_level)).toEqual(['high', 'high']);
  expect(node.validation!.grounding.map((g) => `${g.passed}/${g.total}`)).toEqual(['2/2', '2/2']);

  // verifier sub-agent ran with read-only tools and its verdicts were merged
  const verifier = calls.filter((c) => c.skill === 'verifier');
  expect(verifier.length).toBe(2);
  expect(verifier[0].body.tools.map((x: { name: string }) => x.name).sort()).toEqual(['lookup_rule', 'read_document', 'search_document', 'submit_output', 'verify_quote']);
  expect(node.verification).toMatchObject({ agentUsed: true, summary: { supported: 1, needs_facts: 1, flagged: 1 } });
  expect(node.verification!.items[1].missingFacts).toEqual(['临床研究报告']);
  expect(node.transcript!.some((e) => e.type === 'tool_call' && e.name === 'verifier/lookup_rule')).toBe(true);

  // the extract skill's first user message carries the material as a tagged document with page markers
  const extract = calls.find((c) => c.skill === '营销声明提取')!;
  expect(extract.body.messages[0].content.at(-1).text).toMatch(/<input-[0-9a-f]{8} name="material"/);
  expect(extract.body.messages[0].content.at(-1).text).toContain('<page n="1">');

  // parallel branch + approval
  expect(paused.nodes.deep_review.status).toBe('succeeded');
  expect(paused.nodes.evidence_request.status).toBe('succeeded');
  await t.call('reviewer', 'POST', `/api/runs/${paused.id}/nodes/legal_approval/decision`, { decision: 'approved', comment: '同意' });
  const done = await t.waitRun('runner', paused.id, ['succeeded', 'failed']);
  expect(done.status).toBe('succeeded');
  expect(done.finalOutput).toContain('初审草稿');
  const memo = calls.find((c) => c.skill === '审阅意见书生成')!;
  expect(memo.body.messages[0].content.at(-1).text).toContain('同意'); // approval comment flows into the memo
  expect(done.usage.inputTokens).toBe(1000 * calls.length);
  expect(done.usage.cacheReadTokens).toBe(800 * calls.length);
  expect(done.usage.costUsd).toBeGreaterThan(0);
});
