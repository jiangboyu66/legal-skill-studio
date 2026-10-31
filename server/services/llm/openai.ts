import type { AppConfig } from '../../config';
import { AppError } from '../../errors';
import { postJson } from './http';
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
};

/** Optional request fields that are removed (once) when an endpoint answers 400 naming them. */
const DROPPABLE = ['response_format', 'max_completion_tokens', 'max_tokens', 'reasoning_effort', 'thinking'];

/**
 * OpenAI Chat Completions adapter for any OpenAI-compatible endpoint (OpenAI, DeepSeek, Qwen, Ollama...).
 * Function calling maps to the provider-neutral tool_use / tool_result blocks. Optional parameters are
 * dropped automatically when an endpoint rejects them. Set OPENAI_TOOLS=false for endpoints without tools.
 *
 * Reasoning models (DeepSeek thinking mode) return `reasoning_content`; when tools are in the request it
 * must be sent back on every earlier assistant message, otherwise the API answers 400. It is kept in the
 * message's `raw` field and replayed verbatim — never shown to users or stored in run records.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  info;
  capabilities;
  private dropped = new Set<string>();
  private label: string;
  private keyEnvName: string;

  constructor(private cfg: OpenAICompatibleOptions) {
    this.info = { name: cfg.name ?? ('openai' as const), model: cfg.model, mode: 'real' as const, vision: cfg.vision };
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

    const { data } = await postJson({
      url: `${this.cfg.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      body,
      timeoutMs: this.cfg.timeoutMs,
      providerLabel: this.label,
      keyEnvName: this.keyEnvName,
    });

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
    const finish = choice?.finish_reason ?? 'stop';
    if (finish === 'insufficient_system_resource') {
      throw new AppError('PROVIDER_UNAVAILABLE', `模型服务资源不足，本次生成被中断（${this.label}）。`, { hint: '系统已自动重试。请稍后再运行。', retryable: true });
    }
    const usage = (data.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    const content: Block[] = [];
    if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content });
    for (const c of choice?.message?.tool_calls ?? []) {
      let input: unknown;
      try {
        input = JSON.parse(c.function.arguments || '{}');
      } catch {
        input = { __unparsable_arguments: c.function.arguments };
      }
      content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
    }
    const reasoning = choice?.message?.reasoning_content;
    return {
      content,
      raw: reasoning ? { reasoning_content: reasoning } : undefined,
      model: String(data.model ?? this.cfg.model),
      usage: {
        // Cached prompt tokens are reported separately so they can be priced at the cache-hit rate.
        inputTokens: usage.prompt_tokens !== undefined ? usage.prompt_tokens - (cached ?? 0) : undefined,
        outputTokens: usage.completion_tokens,
        cacheReadTokens: cached || undefined,
      },
      stopReason: choice?.message?.refusal
        ? 'refusal'
        : finish === 'tool_calls'
          ? 'tool_use'
          : finish === 'length'
            ? 'max_tokens'
            : finish === 'content_filter'
              ? 'refusal'
              : 'end',
    };
  }
}
