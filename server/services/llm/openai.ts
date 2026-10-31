import type { AppConfig } from '../../config';
import { AppError } from '../../errors';
import { postJson, postStream } from './http';
import { type Block, type ChatMessage, type CompletionRequest, type CompletionResult, type LLMProvider, textOf } from './types';

type OAMessage = Record<string, unknown>;

export type OpenAICompatibleOptions = AppConfig['openai'] & {
  timeoutMs: number;
  /** Provider identity shown in the UI and run records (default "openai"). */
  name?: 'openai' | 'deepseek';
  /** Label used in error messages (default "OpenAI 兼容接口"). */
  label?: string;
  /** Environment variable that holds the key, for error hints (default OPENAI_API_KEY). */
  keyEnvName?: string;
  /** Extra top-level request fields, e.g. DeepSeek `thinking` / `reasoning_effort`. Dropped if the endpoint rejects them. */
  extraBody?: Record<string, unknown>;
  /** Whether the model returns its reasoning (DeepSeek thinking mode). */
  thinking?: boolean;
};

/** Optional request fields that are removed (once) when an endpoint answers 400 naming them. */
const DROPPABLE = ['stream_options', 'stream', 'response_format', 'max_completion_tokens', 'max_tokens', 'reasoning_effort', 'thinking'];

interface Assembled {
  text: string;
  reasoning: string;
  refusal: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finish: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/**
 * OpenAI Chat Completions adapter for any OpenAI-compatible endpoint (OpenAI, DeepSeek, Qwen, Ollama...).
 * Function calling maps to the provider-neutral tool_use / tool_result blocks. Optional parameters are
 * dropped automatically when an endpoint rejects them. Set OPENAI_TOOLS=false for endpoints without tools.
 *
 * Reasoning models (DeepSeek thinking mode) return `reasoning_content`; when tools are in the request it
 * must be sent back on every earlier assistant message, otherwise the API answers 400. It is kept in the
 * message's `raw` field and replayed verbatim. It is shown and stored only when the run asks for it
 * ("深度思考"); then the request streams so the reasoning can be printed while the model is still thinking.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  info;
  capabilities;
  private dropped = new Set<string>();
  private label: string;
  private keyEnvName: string;

  constructor(private cfg: OpenAICompatibleOptions) {
    this.info = { name: cfg.name ?? ('openai' as const), model: cfg.model, mode: 'real' as const, vision: cfg.vision, thinking: cfg.thinking };
    this.capabilities = { tools: cfg.tools, vision: cfg.vision, pdf: false, promptCache: false };
    this.label = cfg.label ?? 'OpenAI 兼容接口';
    this.keyEnvName = cfg.keyEnvName ?? 'OPENAI_API_KEY';
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.send(req);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'PROVIDER_BAD_REQUEST') throw err;
        const msg = String((err.details as { providerMessage?: string })?.providerMessage ?? '');
        const offending = DROPPABLE.find((p) => msg.includes(p) && !this.dropped.has(p));
        if (!offending) throw err;
        this.dropped.add(offending);
      }
    }
    return this.send(req);
  }

  private tokenParam(): string | null {
    if (!this.cfg.maxTokens) return null;
    const reasoning = /^(gpt-5|o\d)/i.test(this.cfg.model);
    const preferred = reasoning ? 'max_completion_tokens' : 'max_tokens';
    const alternative = reasoning ? 'max_tokens' : 'max_completion_tokens';
    if (!this.dropped.has(preferred)) return preferred;
    if (!this.dropped.has(alternative)) return alternative;
    return null;
  }

  private toMessages(system: string, messages: ChatMessage[]): OAMessage[] {
    const out: OAMessage[] = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'assistant') {
        const calls = m.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
        const reasoning = (m.raw as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        out.push({
          role: 'assistant',
          content: textOf(m.content) || null,
          ...(typeof reasoning === 'string' && reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length
            ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
            : {}),
        });
        continue;
      }
      for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
      const parts: Record<string, unknown>[] = [];
      for (const b of m.content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        if (b.type === 'image' && this.cfg.vision) parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` } });
      }
      if (parts.length) out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
    }
    return out;
  }

  private async send(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.toMessages(req.system.map((s) => s.text).join('\n\n'), req.messages),
    };
    for (const [k, v] of Object.entries(this.cfg.extraBody ?? {})) if (!this.dropped.has(k)) body[k] = v;
    const tp = this.tokenParam();
    if (tp) body[tp] = this.cfg.maxTokens;
    if (req.tools?.length && this.capabilities.tools) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    } else if (this.cfg.jsonMode && req.wantJson && !this.dropped.has('response_format')) {
      body.response_format = { type: 'json_object' };
    }
    const call = {
      url: `${this.cfg.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      body,
      timeoutMs: this.cfg.timeoutMs,
      providerLabel: this.label,
      keyEnvName: this.keyEnvName,
      signal: req.signal,
    };
    // Stream only when someone is watching the reasoning ("深度思考"); otherwise one plain request.
    if (req.onThinking && !this.dropped.has('stream')) return this.toResult(await this.stream(call, body, req.onThinking));

    const { data } = await postJson(call);
    const choice = (Array.isArray(data.choices) ? data.choices[0] : undefined) as
      | {
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
            refusal?: string | null;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
          finish_reason?: string;
        }
      | undefined;
    return this.toResult({
      text: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning_content ?? '',
      refusal: choice?.message?.refusal ?? '',
      toolCalls: (choice?.message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
      finish: choice?.finish_reason ?? 'stop',
      model: typeof data.model === 'string' ? data.model : undefined,
      usage: data.usage as Assembled['usage'],
    });
  }

  /** Streaming request: reasoning deltas go to onThinking as they arrive; text and tool calls are assembled. */
  private async stream(call: Parameters<typeof postStream>[0], body: Record<string, unknown>, onThinking: (d: string) => void): Promise<Assembled> {
    body.stream = true;
    if (!this.dropped.has('stream_options')) body.stream_options = { include_usage: true };
    const a: Assembled = { text: '', reasoning: '', refusal: '', toolCalls: [], finish: '' };
    const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
    await postStream(call, (chunk) => {
      if (typeof chunk.model === 'string') a.model = chunk.model;
      if (chunk.usage && typeof chunk.usage === 'object') a.usage = chunk.usage as Assembled['usage'];
      const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as
        | { delta?: { content?: string | null; reasoning_content?: string | null; refusal?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }
        | undefined;
      if (!choice) return;
      const d = choice.delta ?? {};
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        a.reasoning += d.reasoning_content;
        try {
          onThinking(d.reasoning_content);
        } catch {
          /* display problems must not break the call */
        }
      }
      if (typeof d.content === 'string') a.text += d.content;
      if (typeof d.refusal === 'string') a.refusal += d.refusal;
      for (const tc of d.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : calls.size;
        const cur = calls.get(idx) ?? { arguments: '' };
        if (tc.id) cur.id = tc.id;
        // the name normally arrives once; tolerate it being split or repeated
        if (tc.function?.name) cur.name = cur.name && cur.name !== tc.function.name ? cur.name + tc.function.name : tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (choice.finish_reason) a.finish = choice.finish_reason;
    });
    if (!a.finish) {
      throw new AppError('PROVIDER_NETWORK', `模型服务的流式响应提前结束（${this.label}）。`, { hint: '系统已自动重试。请检查网络或稍后再试。', retryable: true });
    }
    a.toolCalls = [...calls.entries()].sort((x, y) => x[0] - y[0]).map(([i, c]) => ({ id: c.id ?? `call_${i}`, name: c.name ?? '', arguments: c.arguments }));
    return a;
  }

  private toResult(a: Assembled): CompletionResult {
    if (a.finish === 'insufficient_system_resource') {
      throw new AppError('PROVIDER_UNAVAILABLE', `模型服务资源不足，本次生成被中断（${this.label}）。`, { hint: '系统已自动重试。请稍后再运行。', retryable: true });
    }
    const usage = a.usage ?? {};
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    const content: Block[] = [];
    if (a.text) content.push({ type: 'text', text: a.text });
    for (const c of a.toolCalls) {
      let input: unknown;
      try {
        input = JSON.parse(c.arguments || '{}');
      } catch {
        input = { __unparsable_arguments: c.arguments };
      }
      content.push({ type: 'tool_use', id: c.id, name: c.name, input });
    }
    return {
      content,
      raw: a.reasoning ? { reasoning_content: a.reasoning } : undefined,
      reasoning: a.reasoning || undefined,
      model: a.model ?? this.cfg.model,
      usage: {
        // Cached prompt tokens are reported separately so they can be priced at the cache-hit rate.
        inputTokens: usage.prompt_tokens !== undefined ? usage.prompt_tokens - (cached ?? 0) : undefined,
        outputTokens: usage.completion_tokens,
        cacheReadTokens: cached || undefined,
      },
      stopReason: a.refusal
        ? 'refusal'
        : a.finish === 'tool_calls'
          ? 'tool_use'
          : a.finish === 'length'
            ? 'max_tokens'
            : a.finish === 'content_filter'
              ? 'refusal'
              : 'end',
    };
  }
}
