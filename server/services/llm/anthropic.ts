import type { AppConfig } from '../../config';
import { AppError } from '../../errors';
import { postJson } from './http';
import type { Block, ChatMessage, CompletionRequest, CompletionResult, LLMProvider } from './types';

type NativeBlock = Record<string, unknown> & { type: string };

function toNative(b: Block): NativeBlock {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.dataBase64 } };
    case 'document':
      return { type: 'document', source: { type: 'base64', media_type: b.mediaType, data: b.dataBase64 } };
  }
}

function toNativeMessage(m: ChatMessage) {
  if (m.role === 'assistant' && Array.isArray(m.raw)) return { role: 'assistant', content: m.raw };
  return { role: m.role, content: m.content.map(toNative) };
}

/**
 * Claude Messages API adapter (raw HTTP).
 *  - tools → native tool use; tool_result blocks returned as-is
 *  - system layers → array of text blocks; the last static layer gets cache_control (prompt caching)
 *  - assistant turns are replayed with their raw content so thinking blocks stay intact during tool use
 *  - no temperature/top_p/top_k (removed in newer API versions; latest models think adaptively)
 */
export class AnthropicProvider implements LLMProvider {
  info;
  capabilities;
  private dropEffort = false;

  constructor(private cfg: AppConfig['anthropic'] & { timeoutMs: number; promptCache: boolean; vision: boolean }) {
    this.info = { name: 'anthropic' as const, model: cfg.model, mode: 'real' as const, vision: cfg.vision };
    this.capabilities = { tools: true, vision: cfg.vision, pdf: cfg.vision, promptCache: cfg.promptCache };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      return await this.send(req, !this.dropEffort && !!this.cfg.effort);
    } catch (err) {
      if (err instanceof AppError && err.code === 'PROVIDER_BAD_REQUEST' && this.cfg.effort && !this.dropEffort) {
        const msg = String((err.details as { providerMessage?: string })?.providerMessage ?? '');
        if (/output_config|effort/i.test(msg)) {
          this.dropEffort = true;
          return this.send(req, false);
        }
      }
      throw err;
    }
  }

  private async send(req: CompletionRequest, withEffort: boolean): Promise<CompletionResult> {
    const system = req.system.map((s) => ({
      type: 'text',
      text: s.text,
      ...(s.cache && this.cfg.promptCache ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: req.maxTokens,
      system,
      messages: req.messages.map(toNativeMessage),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    }
    if (withEffort) body.output_config = { effort: this.cfg.effort };

    const { data } = await postJson({
      url: `${this.cfg.baseUrl}/v1/messages`,
      headers: { 'x-api-key': this.cfg.apiKey, 'anthropic-version': this.cfg.version },
      body,
      timeoutMs: this.cfg.timeoutMs,
      providerLabel: 'Anthropic',
      keyEnvName: 'ANTHROPIC_API_KEY',
    });

    const native = (Array.isArray(data.content) ? data.content : []) as NativeBlock[];
    const content: Block[] = [];
    for (const b of native) {
      if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
      if (b.type === 'tool_use') content.push({ type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input });
    }
    const stop = String(data.stop_reason ?? '');
    const u = (data.usage ?? {}) as Record<string, number>;
    return {
      content,
      raw: native,
      model: String(data.model ?? this.cfg.model),
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens,
      },
      stopReason: stop === 'end_turn' || stop === 'stop_sequence' ? 'end' : stop || 'end',
    };
  }
}
