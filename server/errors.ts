import type { AppErrorInfo } from '../shared/types';

/** Error with a stable code, a user-facing (Chinese) message and an actionable hint. */
export class AppError extends Error {
  code: string;
  hint?: string;
  status: number;
  details?: unknown;
  retryable: boolean;
  retryAfterMs?: number;
  /** Number of provider calls made before this error was raised (set by the retry helper). */
  attempts?: number;

  constructor(
    code: string,
    message: string,
    opts: { hint?: string; status?: number; details?: unknown; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status ?? 500;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }

  toInfo(): AppErrorInfo {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export function toErrorInfo(err: unknown): AppErrorInfo {
  if (err instanceof AppError) return err.toInfo();
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'INTERNAL_ERROR',
    message: '系统内部错误，请稍后重试。',
    hint: '如问题持续出现，请把运行编号和以下信息反馈给管理员。',
    details: message.slice(0, 500),
  };
}

// ---- Factories for the errors users will actually see ----

export const Errors = {
  /** A run or answer stopped by the user (never retried). */
  canceled: () => new AppError('RUN_CANCELED', '已手动停止。', { status: 409, hint: '可以“从中断处继续”，或重新运行。' }),
  missingInputs: (fields: { key: string; label: string }[]) =>
    new AppError(
      'MISSING_INPUT',
      `缺少必填输入：${fields.map((f) => `「${f.label}」`).join('、')}。`,
      {
        status: 400,
        hint: '请填写标注为必填的字段后再运行。',
        details: { fields: fields.map((f) => f.key) },
      },
    ),
  inputTooLong: (label: string, max: number) =>
    new AppError('INPUT_TOO_LONG', `输入「${label}」过长（超过 ${max.toLocaleString()} 个字符）。`, {
      status: 400,
      hint: '请精简材料或拆分后分别运行。',
    }),
  workflowInvalid: (issues: { message: string }[]) =>
    new AppError('WORKFLOW_INVALID', `工作流配置有误：${issues[0]?.message ?? ''}`, {
      status: 422,
      hint: '请打开工作流编辑器修正标红的配置后再运行。',
      details: { issues },
    }),
  notFound: (what: string) => new AppError('NOT_FOUND', `${what}不存在或已被删除。`, { status: 404 }),
  badRequest: (message: string, hint?: string) => new AppError('BAD_REQUEST', message, { status: 400, hint }),
  unauthenticated: () =>
    new AppError('UNAUTHENTICATED', '请先登录。', { status: 401, hint: '登录状态已过期或尚未登录。' }),
  forbidden: (actionLabel: string, hint?: string) =>
    new AppError('FORBIDDEN', `当前账号没有权限：${actionLabel}。`, {
      status: 403,
      hint: hint ?? '如需此权限，请联系组织管理员调整角色或策略。',
    }),
  conflict: (message: string, hint?: string, details?: unknown) => new AppError('CONFLICT', message, { status: 409, hint, details }),
};
