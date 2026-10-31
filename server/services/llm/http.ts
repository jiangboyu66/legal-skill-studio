import { AppError, Errors } from '../../errors';

export interface HttpCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  providerLabel: string;
  keyEnvName: string;
  /** Aborts the request when the run is stopped (reported as RUN_CANCELED, never retried). */
  signal?: AbortSignal;
}

/** Timeout (reset with touch() while a stream is still sending) linked to the caller's abort signal. */
function linkSignals(timeoutMs: number, outer?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  arm();
  const onAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    touch: arm,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

const timeoutError = (call: HttpCall) =>
  new AppError('PROVIDER_TIMEOUT', `模型调用超时（超过 ${Math.round(call.timeoutMs / 1000)} 秒，${call.providerLabel}）。`, {
    hint: '系统已自动重试。可稍后再试、精简输入，或调大 LLM_TIMEOUT_MS。',
    retryable: true,
  });

/** Extracts a provider error message from Anthropic- or OpenAI-style error bodies. */
function providerMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const err = (body as Record<string, unknown>).error;
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, string>).message;
    }
    if (typeof err === 'string') return err;
    if (typeof (body as Record<string, unknown>).message === 'string') return (body as Record<string, string>).message;
  }
  return typeof body === 'string' ? body : '';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Maps an HTTP failure from a model provider to an AppError with a user-facing message. */
export function mapHttpError(status: number, body: unknown, headers: Headers, call: HttpCall): AppError {
  const msg = providerMessage(body).slice(0, 400);
  const details = { httpStatus: status, providerMessage: msg };
  const p = call.providerLabel;
  if (status === 401 || status === 403) {
    return new AppError('PROVIDER_AUTH', `模型服务鉴权失败（${p}，HTTP ${status}）：API Key 无效、已过期或无权访问该模型。`, {
      hint: `请检查环境变量 ${call.keyEnvName} 是否正确，修改 .env 后重启服务。`,
      details,
    });
  }
  if (status === 402) {
    return new AppError('PROVIDER_QUOTA', `模型服务账户余额不足（${p}，HTTP 402）。`, {
      hint: '请为该账户充值或检查额度，或切换到其他模型供应商；也可先使用模拟模式演示流程。',
      details,
    });
  }
  if (status === 429) {
    if (/credit|quota|insufficient|billing|balance/i.test(msg)) {
      return new AppError('PROVIDER_QUOTA', `模型服务账户额度不足（${p}）。`, {
        hint: '请检查账户余额/额度，或切换到其他模型供应商；也可先使用模拟模式演示流程。',
        details,
      });
    }
    return new AppError('PROVIDER_RATE_LIMIT', `模型服务限流（${p}，HTTP 429），请求过于频繁。`, {
      hint: '系统已自动重试。请稍后再运行，或降低并发/升级额度。',
      details,
      retryable: true,
      retryAfterMs: parseRetryAfter(headers.get('retry-after')),
    });
  }
  if (status === 529 || status >= 500) {
    return new AppError('PROVIDER_UNAVAILABLE', `模型服务暂时不可用（${p}，HTTP ${status}）。`, {
      hint: '系统已自动重试。请稍后再运行；如持续失败请查看供应商状态页。',
      details,
      retryable: true,
    });
  }
  if (status === 404) {
    return new AppError('PROVIDER_NOT_FOUND', `模型服务返回 404（${p}）：模型名称或接口地址可能不正确。`, {
      hint: '请检查 .env 中的模型名称（ANTHROPIC_MODEL / DEEPSEEK_MODEL / OPENAI_MODEL）和接口地址（*_BASE_URL）。',
      details,
    });
  }
  if (/too long|context length|maximum context|too many tokens|prompt is too long/i.test(msg)) {
    return new AppError('INPUT_TOO_LONG_FOR_MODEL', `输入内容超出模型的上下文长度限制（${p}）。`, {
      hint: '请精简材料、缩短参考资料，或换用上下文更长的模型。',
      details,
    });
  }
  return new AppError('PROVIDER_BAD_REQUEST', `模型服务拒绝了请求（${p}，HTTP ${status}）：${msg || '无详细信息'}`, {
    hint: '常见原因：模型名称错误、参数不被该模型支持。请检查 .env 配置。',
    details,
  });
}

/** POST JSON with timeout; throws AppError on network/timeout/HTTP errors (RUN_CANCELED when stopped). */
export async function postJson(call: HttpCall): Promise<{ data: Record<string, unknown>; headers: Headers }> {
  if (call.signal?.aborted) throw Errors.canceled();
  const link = linkSignals(call.timeoutMs, call.signal);
  let res: Response;
  let text = '';
  try {
    res = await fetch(call.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...call.headers },
      body: JSON.stringify(call.body),
      signal: link.signal,
    });
    text = await res.text();
  } catch (err) {
    if (call.signal?.aborted) throw Errors.canceled();
    if (link.timedOut() || (err as Error)?.name === 'AbortError') throw timeoutError(call);
    throw new AppError('PROVIDER_NETWORK', `无法连接模型服务（${call.providerLabel}）：${(err as Error)?.message ?? err}`, {
      hint: '请检查网络、代理设置和接口地址（*_BASE_URL）。',
      retryable: true,
    });
  } finally {
    link.done();
  }
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* keep raw text */
  }
  if (!res.ok) throw mapHttpError(res.status, body, res.headers, call);
  if (!body || typeof body !== 'object') {
    throw new AppError('PROVIDER_BAD_RESPONSE', `模型服务返回了无法解析的响应（${call.providerLabel}）。`, {
      hint: '请检查接口地址是否指向兼容的 API。',
      details: { sample: String(text).slice(0, 200) },
    });
  }
  return { data: body as Record<string, unknown>, headers: res.headers };
}

/**
 * POST with a Server-Sent Events response (OpenAI-style streaming): calls onData for every `data:` JSON
 * chunk until `[DONE]`. Comment lines (keep-alive) are ignored. The timeout is an idle timeout: it is
 * reset whenever data arrives, so long reasoning is not cut off while the model is still writing.
 */
export async function postStream(call: HttpCall, onData: (chunk: Record<string, unknown>) => void): Promise<{ headers: Headers; done: boolean }> {
  if (call.signal?.aborted) throw Errors.canceled();
  const link = linkSignals(call.timeoutMs, call.signal);
  const fail = (err: unknown): never => {
    if (err instanceof AppError) throw err;
    if (call.signal?.aborted) throw Errors.canceled();
    if (link.timedOut() || (err as Error)?.name === 'AbortError') throw timeoutError(call);
    throw new AppError('PROVIDER_NETWORK', `与模型服务的连接中断（${call.providerLabel}）：${(err as Error)?.message ?? err}`, {
      hint: '系统已自动重试。请检查网络、代理设置和接口地址（*_BASE_URL）。',
      retryable: true,
    });
  };
  try {
    let res: Response;
    try {
      res = await fetch(call.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...call.headers },
        body: JSON.stringify(call.body),
        signal: link.signal,
      });
    } catch (err) {
      return fail(err);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        /* keep raw text */
      }
      throw mapHttpError(res.status, body, res.headers, call);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        link.touch();
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, cut).replace(/\r$/, '');
          buf = buf.slice(cut + 1);
          if (!line.startsWith('data:')) continue; // blank separators, ": keep-alive" comments, event names
          const data = line.slice(5).trim();
          if (data === '[DONE]') return { headers: res.headers, done: true };
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (chunk.error) throw mapHttpError(500, chunk, res.headers, call);
          onData(chunk);
        }
      }
    } catch (err) {
      return fail(err);
    }
    return { headers: res.headers, done: false };
  } finally {
    link.done();
  }
}
