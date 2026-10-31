import type { FaultType } from '../../../shared/types';
import type { AppConfig } from '../../config';
import { AppError, Errors } from '../../errors';
import type { FeatureSet } from '../../features';
import { AnthropicProvider } from './anthropic';
import { MockProvider } from './mock';
import { OpenAICompatibleProvider } from './openai';
import type { Block, CompletionRequest, CompletionResult, LLMProvider } from './types';

export type { LLMProvider } from './types';

/** Chooses the provider from configuration. API keys come from environment variables only. */
export function createProvider(cfg: AppConfig, features: FeatureSet): LLMProvider {
  const pick =
    cfg.provider === 'auto' ? (cfg.anthropic.apiKey ? 'anthropic' : cfg.deepseek.apiKey ? 'deepseek' : cfg.openai.apiKey ? 'openai' : 'mock') : cfg.provider;
  if (pick === 'anthropic') {
    if (!cfg.anthropic.apiKey) return new MisconfiguredProvider('anthropic', cfg.anthropic.model, 'ANTHROPIC_API_KEY');
    return new AnthropicProvider({ ...cfg.anthropic, timeoutMs: cfg.timeoutMs, promptCache: features.PROMPT_CACHE, vision: features.VISION });
  }
  if (pick === 'deepseek') {
    const d = cfg.deepseek;
    if (!d.apiKey) return new MisconfiguredProvider('deepseek', d.model, 'DEEPSEEK_API_KEY');
    // Thinking mode (API default) + reasoning effort; the adapter replays reasoning_content in tool loops.
    const extraBody: Record<string, unknown> = { thinking: { type: d.thinking } };
    if (d.thinking === 'enabled' && d.reasoningEffort) extraBody.reasoning_effort = d.reasoningEffort;
    return new OpenAICompatibleProvider({
      apiKey: d.apiKey,
      model: d.model,
      baseUrl: d.baseUrl,
      jsonMode: false,
      maxTokens: d.maxTokens,
      tools: d.tools,
      vision: d.vision && features.VISION,
      timeoutMs: cfg.timeoutMs,
      name: 'deepseek',
      label: 'DeepSeek',
      keyEnvName: 'DEEPSEEK_API_KEY',
      extraBody,
      thinking: d.thinking === 'enabled',
    });
  }
  if (pick === 'openai') {
    if (!cfg.openai.apiKey) return new MisconfiguredProvider('openai', cfg.openai.model, 'OPENAI_API_KEY');
    return new OpenAICompatibleProvider({ ...cfg.openai, vision: cfg.openai.vision && features.VISION, timeoutMs: cfg.timeoutMs });
  }
  return new MockProvider(cfg.mockLatencyMs);
}

/** API key of the configured real provider ('' for mock / missing). */
export function providerKey(cfg: AppConfig, name: string): string {
  return name === 'anthropic' ? cfg.anthropic.apiKey : name === 'deepseek' ? cfg.deepseek.apiKey : name === 'openai' ? cfg.openai.apiKey : '';
}

class MisconfiguredProvider implements LLMProvider {
  info;
  capabilities = { tools: true, vision: false, pdf: false, promptCache: false };
  constructor(name: 'anthropic' | 'openai' | 'deepseek', model: string, private keyName: string) {
    this.info = { name, model, mode: 'real' as const, vision: false };
  }
  async complete(): Promise<CompletionResult> {
    throw new AppError('PROVIDER_NOT_CONFIGURED', `未配置模型密钥：环境变量 ${this.keyName} 为空。`, {
      hint: `在 .env 中填写 ${this.keyName} 后重启服务；或设置 LLM_PROVIDER=mock 使用模拟模式。`,
    });
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * Error categorisation + retry (cf. QueryEngine categorizeRetryableAPIError):
 * rate_limit / network / server / timeout are retried with exponential backoff (respecting retry-after);
 * auth, quota and bad-request errors are not.
 */
export async function completeWithRetry(
  provider: LLMProvider,
  req: CompletionRequest,
  opts: { maxRetries: number; baseMs: number; onRetry?: (attempt: number, err: AppError) => void },
): Promise<{ result: CompletionResult; attempts: number }> {
  let attempt = 0;
  for (;;) {
    attempt++;
    if (req.signal?.aborted) throw Errors.canceled();
    try {
      return { result: await provider.complete(req), attempts: attempt };
    } catch (err) {
      if (req.signal?.aborted) throw Errors.canceled();
      const retryable = err instanceof AppError && err.retryable;
      if (!retryable || attempt > opts.maxRetries) {
        if (err instanceof AppError) {
          err.attempts = attempt;
          if (retryable && attempt > 1) err.message = `${err.message}（已自动重试 ${attempt - 1} 次）`;
        }
        throw err;
      }
      opts.onRetry?.(attempt, err as AppError);
      await sleep(Math.min((err as AppError).retryAfterMs ?? opts.baseMs * 2 ** (attempt - 1), 20_000), req.signal);
    }
  }
}

/** Wraps a provider to simulate failures so error handling can be reproduced without breaking a real key. */
export class FaultInjectingProvider implements LLMProvider {
  info;
  capabilities;
  private calls = 0;
  constructor(private inner: LLMProvider, private fault: FaultType, private timeoutDelayMs = 300) {
    this.info = inner.info;
    this.capabilities = inner.capabilities;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls++;
    const tag = '（故障注入）';
    const invalid = (): CompletionResult => {
      const submit = req.tools?.some((t) => t.name === 'submit_output');
      const content: Block[] = submit
        ? [{ type: 'tool_use', id: `toolu_fault_${this.calls}`, name: 'submit_output', input: { unexpected: '故障注入：缺少必填字段' } }]
        : [{ type: 'text', text: req.wantJson ? '抱歉，我无法按要求输出。（故障注入：非 JSON 内容）' : '' }];
      return { content, model: this.info.model, stopReason: submit ? 'tool_use' : 'end' };
    };
    switch (this.fault) {
      case 'auth':
        throw new AppError('PROVIDER_AUTH', `模型服务鉴权失败（HTTP 401）：API Key 无效、已过期或无权访问该模型。${tag}`, { hint: '请检查 .env 中的 API Key，修改后重启服务。' });
      case 'rate_limit':
        throw new AppError('PROVIDER_RATE_LIMIT', `模型服务限流（HTTP 429），请求过于频繁。${tag}`, { hint: '系统已自动重试。请稍后再运行，或降低并发/升级额度。', retryable: true });
      case 'server_error':
        throw new AppError('PROVIDER_UNAVAILABLE', `模型服务暂时不可用（HTTP 503）。${tag}`, { hint: '系统已自动重试。请稍后再运行。', retryable: true });
      case 'timeout':
        await sleep(this.timeoutDelayMs);
        throw new AppError('PROVIDER_TIMEOUT', `模型调用超时。${tag}`, { hint: '系统已自动重试。可稍后再试、精简输入，或调大 LLM_TIMEOUT_MS。', retryable: true });
      case 'bad_output':
        return invalid();
      case 'bad_output_once':
        return this.calls === 1 ? invalid() : this.inner.complete(req);
      default:
        return this.inner.complete(req);
    }
  }
}
