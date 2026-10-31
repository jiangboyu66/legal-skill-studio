import { AppError } from '../../errors';

export interface HttpCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  providerLabel: string;
  keyEnvName: string;
}

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

/** POST JSON with timeout; throws AppError on network/timeout/HTTP errors. */
export async function postJson(call: HttpCall): Promise<{ data: Record<string, unknown>; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  let res: Response;
  try {
    res = await fetch(call.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...call.headers },
      body: JSON.stringify(call.body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === 'AbortError') {
      throw new AppError('PROVIDER_TIMEOUT', `模型调用超时（超过 ${Math.round(call.timeoutMs / 1000)} 秒，${call.providerLabel}）。`, {
        hint: '系统已自动重试。可稍后再试、精简输入，或调大 LLM_TIMEOUT_MS。',
        retryable: true,
      });
    }
    throw new AppError('PROVIDER_NETWORK', `无法连接模型服务（${call.providerLabel}）：${(err as Error)?.message ?? err}`, {
      hint: '请检查网络、代理设置和接口地址（*_BASE_URL）。',
      retryable: true,
    });
  }
  let text = '';
  try {
    text = await res.text();
  } finally {
    clearTimeout(timer);
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
