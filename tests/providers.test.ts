/**
 * Contract tests for the real-provider adapters against a local fake HTTP server: request shape
 * (tools, tool results, cache markers, images/PDFs, thinking replay), response parsing and error mapping.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { loadConfig } from '../server/config';
import { QueryEngine } from '../server/core/queryEngine';
import { AppError } from '../server/errors';
import { resolveFeatures } from '../server/features';
import { completeWithRetry, createProvider } from '../server/services/llm';
import { AnthropicProvider } from '../server/services/llm/anthropic';
import { OpenAICompatibleProvider } from '../server/services/llm/openai';
import type { CompletionRequest, LLMProvider } from '../server/services/llm/types';

type Reply = { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number };
let queue: Reply[] = [];
let seen: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> }[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      const r = queue.shift() ?? { status: 500, body: { error: { message: 'no reply queued' } } };
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
beforeEach(() => {
  queue = [];
  seen = [];
});

const anthropic = (extra: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) =>
  new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', baseUrl: base, version: '2023-06-01', effort: '', timeoutMs: 2000, promptCache: true, vision: true, ...extra });
const openai = (extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) =>
  new OpenAICompatibleProvider({ apiKey: 'sk-oa', model: 'gpt-5-mini', baseUrl: `${base}/v1`, jsonMode: false, maxTokens: 0, tools: true, vision: false, timeoutMs: 2000, ...extra });

const tool = { name: 'lookup_rule', description: 'Look up rules', inputSchema: { type: 'object', properties: { rule_ids: { type: 'array', items: { type: 'string' } } } } };
const req: CompletionRequest = {
  system: [{ text: 'STATIC', cache: true }, { text: 'DYNAMIC' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [tool],
  maxTokens: 1234,
};

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as AppError).code;
  }
}

describe('Anthropic Messages API adapter', () => {
  it('sends layered system blocks with a cache marker, native tools, and no sampling parameters', async () => {
    queue.push({
      status: 200,
      body: {
        model: 'claude-sonnet-5-5',
        content: [
          { type: 'thinking', thinking: 'internal', signature: 'sig' },
          { type: 'text', text: 'Looking up.' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup_rule', input: { rule_ids: ['A-1'] } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      },
    });
    const r = await anthropic().complete(req);
    expect(r.content).toEqual([
      { type: 'text', text: 'Looking up.' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup_rule', input: { rule_ids: ['A-1'] } },
    ]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 });
    const call = seen[0];
    expect(call.url).toBe('/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-test');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 1234,
      system: [{ type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'DYNAMIC' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'lookup_rule', description: 'Look up rules', input_schema: tool.inputSchema }],
    });
    for (const k of ['temperature', 'top_p', 'top_k']) expect(call.body).not.toHaveProperty(k);
  });

  it('replays assistant turns verbatim (thinking blocks) and maps tool results, images and PDFs', async () => {
    queue.push({ status: 200, body: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    const raw = [{ type: 'thinking', thinking: 'secret', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'lookup_rule', input: {} }];
    await anthropic({ promptCache: false }).complete({
      ...req,
      messages: [
        { role: 'user', content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'iVBO' }, { type: 'document', mediaType: 'application/pdf', dataBase64: 'JVBE' }, { type: 'text', text: 'check' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup_rule', input: {} }], raw },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: 'ERROR: unknown', isError: true }] },
      ],
    });
    const m = seen[0].body.messages;
    expect(m[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBO' } });
    expect(m[0].content[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } });
    expect(m[1]).toEqual({ role: 'assistant', content: raw });
    expect(m[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ERROR: unknown', is_error: true });
    expect(seen[0].body.system[0]).not.toHaveProperty('cache_control');
  });

  it('maps HTTP errors to actionable codes and honours retry-after', async () => {
    queue.push({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    expect(await codeOf(anthropic().complete(req))).toBe('PROVIDER_AUTH');
    queue.push({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    expect(await codeOf(anthropic().complete(req))).toBe('PROVIDER_UNAVAILABLE');
    queue.push({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' } } });
    expect(await codeOf(anthropic().complete(req))).toBe('INPUT_TOO_LONG_FOR_MODEL');
    queue.push({ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } } });
    expect(await codeOf(anthropic().complete(req))).toBe('PROVIDER_NOT_FOUND');
    queue.push({ status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '3' } });
    const e = await anthropic()
      .complete(req)
      .catch((x) => x as AppError);
    expect(e).toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true, retryAfterMs: 3000 });
  });

  it('drops the optional effort setting if the API rejects it, and times out slow responses', async () => {
    queue.push({ status: 400, body: { error: { message: 'output_config.effort: Extra inputs are not permitted' } } });
    queue.push({ status: 200, body: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
    const r = await anthropic({ effort: 'low' }).complete(req);
    expect(r.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(seen[0].body).toHaveProperty('output_config', { effort: 'low' });
    expect(seen[1].body).not.toHaveProperty('output_config');
    queue.push({ status: 200, body: { content: [] }, delayMs: 400 });
    expect(await codeOf(anthropic({ timeoutMs: 100 }).complete(req))).toBe('PROVIDER_TIMEOUT');
  });
});

describe('OpenAI-compatible adapter', () => {
  it('maps tools to function calling and tool results to role "tool" messages', async () => {
    queue.push({
      status: 200,
      body: {
        model: 'gpt-5-mini',
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_rule', arguments: '{"rule_ids":["A-1"]}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    });
    const r = await openai().complete({
      ...req,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'call_0', name: 'lookup_rule', input: { rule_ids: [] } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_0', content: 'none' }] },
      ],
    });
    expect(r).toMatchObject({ stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2 } });
    expect(r.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'lookup_rule', input: { rule_ids: ['A-1'] } }]);
    const b = seen[0].body;
    expect(seen[0].url).toBe('/v1/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer sk-oa');
    expect(b.messages[0]).toEqual({ role: 'system', content: 'STATIC\n\nDYNAMIC' });
    expect(b.messages[2]).toEqual({ role: 'assistant', content: 'calling', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'lookup_rule', arguments: '{"rule_ids":[]}' } }] });
    expect(b.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'none' });
    expect(b.tools[0]).toEqual({ type: 'function', function: { name: 'lookup_rule', description: 'Look up rules', parameters: tool.inputSchema } });
  });

  it('sends images only to vision-enabled endpoints and switches the max-token parameter when rejected', async () => {
    queue.push({ status: 200, body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
    await openai({ vision: true }).complete({ ...req, tools: [], messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'iVBO' }, { type: 'text', text: 'see' }] }] });
    expect(seen[0].body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } });

    queue.push({ status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." } } });
    queue.push({ status: 200, body: { choices: [{ message: { content: 'ok' }, finish_reason: 'length' }] } });
    const r = await openai({ model: 'deepseek-chat', maxTokens: 800 }).complete(req);
    expect(seen[1].body).toHaveProperty('max_tokens', 800);
    expect(seen[2].body).toHaveProperty('max_completion_tokens', 800);
    expect(r.stopReason).toBe('max_tokens');
  });

  it('maps quota errors to a non-retryable code and refusals to "refusal"', async () => {
    queue.push({ status: 429, body: { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } } });
    expect(await codeOf(openai().complete(req))).toBe('PROVIDER_QUOTA');
    queue.push({ status: 200, body: { choices: [{ message: { content: null, refusal: 'I cannot help' }, finish_reason: 'stop' }] } });
    expect((await openai().complete(req)).stopReason).toBe('refusal');
  });
});


const deepseek = (extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) =>
  new OpenAICompatibleProvider({
    apiKey: 'sk-ds',
    model: 'deepseek-flash',
    baseUrl: base,
    jsonMode: false,
    maxTokens: 32768,
    tools: true,
    vision: true,
    timeoutMs: 2000,
    name: 'deepseek',
    label: 'DeepSeek',
    keyEnvName: 'DEEPSEEK_API_KEY',
    extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    ...extra,
  });
const dsToolCall = {
  model: 'deepseek-flash',
  choices: [
    {
      message: { content: '', reasoning_content: 'Check the rule first.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_rule', arguments: '{"rule_ids":["SCAP-04"]}' } }] },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
};

describe('DeepSeek (deepseek-flash via the OpenAI-compatible API, thinking mode)', () => {
  it('sends thinking / reasoning_effort / max_tokens, separates cache hits, and replays reasoning_content on assistant turns', async () => {
    const p = deepseek();
    expect(p.info).toMatchObject({ name: 'deepseek', model: 'deepseek-flash', mode: 'real', vision: true });
    queue.push({ status: 200, body: dsToolCall });
    const r1 = await p.complete(req);
    expect(seen[0].url).toBe('/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer sk-ds');
    expect(seen[0].body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 32768 });
    expect(seen[0].body).not.toHaveProperty('temperature');
    expect(r1.usage).toEqual({ inputTokens: 40, outputTokens: 20, cacheReadTokens: 60 });
    expect(r1.raw).toEqual({ reasoning_content: 'Check the rule first.' });
    expect(r1.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'lookup_rule', input: { rule_ids: ['SCAP-04'] } }]);

    queue.push({ status: 200, body: { choices: [{ message: { content: 'done', reasoning_content: 'ok' }, finish_reason: 'stop' }] } });
    await p.complete({ ...req, messages: [...req.messages, { role: 'assistant', content: r1.content, raw: r1.raw }, { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'rule text' }] }] });
    const msgs = seen[1].body.messages;
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: null, reasoning_content: 'Check the rule first.', tool_calls: [{ id: 'call_1', type: 'function' }] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'rule text' });
  });

  it('keeps reasoning_content across the agent loop (DeepSeek returns 400 without it when tools are used)', async () => {
    queue.push({ status: 200, body: dsToolCall });
    queue.push({
      status: 200,
      body: { choices: [{ message: { content: '', reasoning_content: 'Now submit.', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'submit_output', arguments: '{"result":"ok"}' } }] }, finish_reason: 'tool_calls' }] },
    });
    const engine = new QueryEngine({
      provider: deepseek(),
      system: [{ text: 'S' }],
      tools: [{ ...tool, category: 'knowledge', readOnly: true, call: async () => ({ content: 'SCAP-04 text', summary: 'ok' }) } as never],
      toolContext: { documents: {}, rules: new Map(), inputs: {} },
      outputFields: [{ key: 'result', type: 'string', required: true }],
      useTools: true,
      canUseTool: () => 'allow',
      grantedTools: [],
      maxTurns: 4,
      maxTokens: 1000,
      retry: { maxRetries: 0, baseMs: 1 },
    });
    const r = await engine.run([{ type: 'text', text: 'check' }]);
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ result: 'ok' });
    const second = seen[1].body.messages as Record<string, unknown>[];
    expect(second.find((m) => m.role === 'assistant')).toMatchObject({ reasoning_content: 'Check the rule first.' });
    expect(JSON.stringify(r.transcript)).not.toContain('Check the rule first.'); // reasoning is never stored in the run record
  });

  it('maps 402 (balance), insufficient_system_resource (retryable) and drops thinking params an endpoint rejects', async () => {
    queue.push({ status: 402, body: { error: { message: 'Insufficient Balance' } } });
    expect(await codeOf(deepseek().complete(req))).toBe('PROVIDER_QUOTA');
    queue.push({ status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'insufficient_system_resource' }] } });
    const e = (await deepseek().complete(req).catch((x) => x)) as AppError;
    expect(e.code).toBe('PROVIDER_UNAVAILABLE');
    expect(e.retryable).toBe(true);
    queue.push({ status: 400, body: { error: { message: 'Unrecognized request argument supplied: thinking' } } });
    queue.push({ status: 200, body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
    const n = seen.length;
    await deepseek().complete(req);
    expect(seen[n].body).toHaveProperty('thinking');
    expect(seen[n + 1].body).not.toHaveProperty('thinking');
    expect(seen[n + 1].body).toHaveProperty('reasoning_effort', 'high');
  });

  it('sends images as base64 data URLs (deepseek-flash accepts image input)', async () => {
    queue.push({ status: 200, body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
    await deepseek().complete({ ...req, tools: [], messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'iVBO' }, { type: 'text', text: 'see' }] }] });
    expect(seen[0].body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } });
  });

  it('is chosen by LLM_PROVIDER=deepseek or auto with only DEEPSEEK_API_KEY; disabled thinking sends no reasoning_effort', async () => {
    const ds = { apiKey: 'sk-ds', model: 'deepseek-flash', baseUrl: base, thinking: 'disabled' as const, reasoningEffort: 'high', maxTokens: 0, tools: true, vision: false };
    const none = { apiKey: '', model: 'm', baseUrl: 'http://x', version: 'v', effort: '' };
    const auto = createProvider(loadConfig({ provider: 'auto', deepseek: ds, anthropic: none, openai: { ...none, jsonMode: false, maxTokens: 0, tools: true, vision: false } }), resolveFeatures(''));
    expect(auto.info).toMatchObject({ name: 'deepseek', model: 'deepseek-flash' });
    queue.push({ status: 200, body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
    await auto.complete(req);
    expect(seen[0].body.thinking).toEqual({ type: 'disabled' });
    expect(seen[0].body).not.toHaveProperty('reasoning_effort');
    expect(seen[0].body).not.toHaveProperty('max_tokens');
    const missing = createProvider(loadConfig({ provider: 'deepseek', deepseek: { ...ds, apiKey: '' } }), resolveFeatures(''));
    expect(await codeOf(missing.complete(req))).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('prices cache hits at the configured cache-read rate (DeepSeek bills them far below cache misses)', async () => {
    const { ctx, close } = await createApp({
      config: { dataDir: mkdtempSync(path.join(os.tmpdir(), 'lss-price-')), provider: 'mock', priceInputPerMTok: 0.3, priceOutputPerMTok: 1.2, priceCacheReadPerMTok: 0.006 },
      resume: false,
    });
    expect(ctx.rt.priceFn({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 })).toBeCloseTo(1.506, 6);
    await close();
  });
});

describe('retry helper', () => {
  it('retries retryable errors with backoff, then succeeds; non-retryable errors fail fast', async () => {
    let n = 0;
    const flaky: LLMProvider = {
      info: { name: 'mock', model: 'm', mode: 'mock', vision: false },
      capabilities: { tools: true, vision: false, pdf: false, promptCache: false },
      complete: async () => {
        n++;
        if (n < 3) throw new AppError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
        return { content: [{ type: 'text', text: 'ok' }], model: 'm', stopReason: 'end' };
      },
    };
    const r = await completeWithRetry(flaky, req, { maxRetries: 2, baseMs: 1 });
    expect(r.attempts).toBe(3);
    let m = 0;
    const broken: LLMProvider = { ...flaky, complete: async () => (m++, Promise.reject(new AppError('PROVIDER_AUTH', 'bad key'))) };
    const e = await completeWithRetry(broken, req, { maxRetries: 2, baseMs: 1 }).catch((x) => x as AppError);
    expect(e).toMatchObject({ code: 'PROVIDER_AUTH', attempts: 1 });
    expect(m).toBe(1);
  });
});
