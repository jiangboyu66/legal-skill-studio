import type {
  AuditEvent,
  ChatMode,
  ChatSendResult,
  Conversation,
  ConversationSummary,
  DemoAccounts,
  DocumentSummary,
  EvalRun,
  FaultInjection,
  FaultType,
  MaterialDocument,
  Me,
  Meta,
  MissedFinding,
  OptimizationRun,
  OrgPolicy,
  PlatformInfo,
  RunEvent,
  ReviewDecision,
  ReviewDetail,
  ReviewInbox,
  ReviewMark,
  ReviewRequest,
  ReviewRequestView,
  Role,
  RulePackContent,
  RulePackView,
  Run,
  RunOptions,
  RunSummary,
  SampleMaterial,
  SkillConfig,
  SkillEvalsView,
  SkillTestResult,
  SkillView,
  User,
  ValidationIssue,
  WorkflowDef,
  WorkflowView,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public hint?: string,
    public status?: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Called when the session has expired (401) so the app can show the login page. */
let onUnauthenticated: () => void = () => {};
export const setUnauthenticatedHandler = (fn: () => void) => {
  onUnauthenticated = fn;
};

// ── Per-tab sessions ──
// Each browser tab keeps its own session token (sessionStorage) and sends it as a bearer token, so a
// reviewer and a runner can be signed in side by side in two tabs of one browser. A new tab starts with
// the most recent login. The server ignores the shared cookie for requests marked x-session-mode: tab.
const TAB_KEY = 'lss.session';
const LAST_KEY = 'lss.lastSession';
/** This tab started from the most recent login of another tab; it trades that for a session of its own. */
let inherited = false;
let token: string | null = (() => {
  try {
    const own = sessionStorage.getItem(TAB_KEY);
    if (own) return own;
    const last = localStorage.getItem(LAST_KEY);
    if (last) {
      inherited = true;
      sessionStorage.setItem(TAB_KEY, last);
    }
    return last;
  } catch {
    return null;
  }
})();

function setSessionToken(t: string | null, opts: { tabOnly?: boolean } = {}) {
  const prev = token;
  token = t;
  try {
    if (t) {
      sessionStorage.setItem(TAB_KEY, t);
      if (!opts.tabOnly) localStorage.setItem(LAST_KEY, t);
    } else {
      sessionStorage.removeItem(TAB_KEY);
      if (prev && localStorage.getItem(LAST_KEY) === prev) localStorage.removeItem(LAST_KEY);
    }
  } catch {
    /* storage unavailable: the token lives in memory for this page */
  }
}

const sessionHeaders = (): Record<string, string> => ({ 'x-session-mode': 'tab', ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function parse<T>(res: Response, url: string): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = ((data as { error?: Record<string, unknown> })?.error ?? {}) as Record<string, unknown>;
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      setSessionToken(null);
      onUnauthenticated();
    }
    throw new ApiError(String(e.code ?? `HTTP_${res.status}`), String(e.message ?? `请求失败（HTTP ${res.status}）`), e.hint as string | undefined, res.status, e.details);
  }
  return data as T;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      // Custom header required by the server's CSRF guard for state-changing requests.
      headers: { 'x-requested-with': 'lss', ...sessionHeaders(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK', '无法连接服务器。', '请确认后端服务已启动（npm run dev 或 npm start）。');
  }
  return parse<T>(res, url);
}

async function upload<T>(url: string, file: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'lss', ...sessionHeaders(), 'content-type': 'application/octet-stream' }, body: file });
  } catch {
    throw new ApiError('NETWORK', '上传失败：无法连接服务器。');
  }
  return parse<T>(res, url);
}

/** Downloads a file with this tab's session (a plain link would use another tab's cookie). */
export async function download(url: string, fallbackName: string) {
  const res = await fetch(url, { headers: sessionHeaders() });
  if (!res.ok) await parse(res, url);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** Opens a stored original (PDF / image) in a new tab with this tab's session. */
export async function openFile(url: string) {
  const w = window.open('', '_blank');
  try {
    const res = await fetch(url, { headers: sessionHeaders() });
    if (!res.ok) await parse(res, url);
    const href = URL.createObjectURL(await res.blob());
    if (w) w.location.href = href;
    else window.location.href = href;
  } catch (e) {
    w?.close();
    throw e;
  }
}

/**
 * Server-sent events over fetch (EventSource cannot send this tab's session header).
 * Returns a function that closes the stream.
 */
export function streamEvents(url: string, h: { onOpen?: () => void; onEvent: (e: RunEvent) => void; onClose?: (err?: unknown) => void }): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { headers: { ...sessionHeaders(), accept: 'text/event-stream' }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new ApiError(`HTTP_${res.status}`, '实时连接失败', undefined, res.status);
      h.onOpen?.();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (event !== 'message' || !data.length) continue;
          try {
            h.onEvent(JSON.parse(data.join('\n')) as RunEvent);
          } catch {
            /* ignore a malformed event */
          }
        }
      }
      if (!ctrl.signal.aborted) h.onClose?.();
    } catch (err) {
      if (!ctrl.signal.aborted) h.onClose?.(err);
    }
  })();
  return () => ctrl.abort();
}

/** Live events of one run (status, activity log, transcript, streamed reasoning). */
export const streamRunEvents = (runId: string, h: Parameters<typeof streamEvents>[1]) => streamEvents(`/api/runs/${runId}/events`, h);

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : '';
};

export type InputValue = string | { documentId: string };

export const api = {
  meta: () => req<Meta>('GET', '/api/meta'),
  samples: () => req<SampleMaterial[]>('GET', '/api/samples'),
  sampleDocument: (id: string) => req<DocumentSummary>('POST', `/api/samples/${id}/document`),
  auth: {
    me: async () => {
      if (inherited && token) {
        inherited = false;
        try {
          const r = await req<{ sessionToken?: string }>('POST', '/api/auth/fork');
          if (r.sessionToken) setSessionToken(r.sessionToken, { tabOnly: true });
        } catch {
          /* the inherited session has ended: /me below reports it */
        }
      }
      return req<Me>('GET', '/api/auth/me');
    },
    login: async (email: string, password: string) => {
      const me = await req<Me>('POST', '/api/auth/login', { email, password });
      if (me.sessionToken) setSessionToken(me.sessionToken);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { sessionToken, ...rest } = me;
      return rest as Me;
    },
    logout: async () => {
      try {
        return await req<{ ok: true }>('POST', '/api/auth/logout');
      } finally {
        setSessionToken(null);
      }
    },
    demoAccounts: () => req<DemoAccounts>('GET', '/api/auth/demo-accounts'),
  },
  skills: {
    list: () => req<SkillView[]>('GET', '/api/skills'),
    get: (id: string) => req<SkillView>('GET', `/api/skills/${id}`),
    create: (s: { name: string; description: string; category?: string; jurisdiction?: string; config: SkillConfig }) => req<SkillView>('POST', '/api/skills', s),
    update: (id: string, s: { name: string; description: string; category?: string; jurisdiction?: string; config: SkillConfig }) => req<SkillView>('PUT', `/api/skills/${id}`, s),
    remove: (id: string) => req<{ ok: true }>('DELETE', `/api/skills/${id}`),
    duplicate: (id: string) => req<SkillView>('POST', `/api/skills/${id}/duplicate`),
    submit: (id: string, note: string) => req<ReviewRequest>('POST', `/api/skills/${id}/submit`, { note }),
    test: (id: string, body: { inputs: Record<string, InputValue>; config?: SkillConfig; fault?: FaultType }) => req<SkillTestResult>('POST', `/api/skills/${id}/test`, body),
    version: (id: string, v: number) => req<SkillConfig>('GET', `/api/skills/${id}/versions/${v}`),
    importMd: (content: string) => req<{ skill: SkillView; warnings: string[] }>('POST', '/api/skills/import', { content }),
    exportUrl: (id: string, version?: 'published') => `/api/skills/${id}/export${q({ version })}`,
    evals: (id: string) => req<SkillEvalsView>('GET', `/api/skills/${id}/evals`),
    startEval: (id: string, target: 'draft' | 'published', split: EvalRun['split'] = 'all') => req<EvalRun>('POST', `/api/skills/${id}/evals`, { target, split }),
    optimize: (id: string, baselineEvalId: string) => req<OptimizationRun>('POST', `/api/skills/${id}/optimizations`, { baselineEvalId }),
    adopt: (id: string, optimizationId: string) => req<SkillView>('POST', `/api/skills/${id}/optimizations/${optimizationId}/adopt`),
  },
  evals: {
    get: (id: string) => req<EvalRun>('GET', `/api/evals/${id}`),
  },
  rulePacks: {
    list: () => req<RulePackView[]>('GET', '/api/rulepacks'),
    get: (id: string) => req<RulePackView>('GET', `/api/rulepacks/${id}`),
    create: (p: { name: string; jurisdiction: string; description: string; content: RulePackContent }) => req<RulePackView>('POST', '/api/rulepacks', p),
    update: (id: string, p: { name: string; jurisdiction: string; description: string; content: RulePackContent }) => req<RulePackView>('PUT', `/api/rulepacks/${id}`, p),
    remove: (id: string) => req<{ ok: true }>('DELETE', `/api/rulepacks/${id}`),
    submit: (id: string, note: string) => req<ReviewRequest>('POST', `/api/rulepacks/${id}/submit`, { note }),
    validate: (content: RulePackContent) => req<{ issues: string[] }>('POST', '/api/rulepacks/validate', { content }),
  },
  workflows: {
    list: () => req<WorkflowView[]>('GET', '/api/workflows'),
    get: (id: string) => req<WorkflowView>('GET', `/api/workflows/${id}`),
    create: (w: { name: string; description: string; def: WorkflowDef }) => req<WorkflowView>('POST', '/api/workflows', w),
    update: (id: string, w: { name: string; description: string; def: WorkflowDef }) => req<WorkflowView>('PUT', `/api/workflows/${id}`, w),
    remove: (id: string) => req<{ ok: true }>('DELETE', `/api/workflows/${id}`),
    duplicate: (id: string) => req<WorkflowView>('POST', `/api/workflows/${id}/duplicate`),
    submit: (id: string, note: string) => req<ReviewRequest>('POST', `/api/workflows/${id}/submit`, { note }),
    validate: (def: WorkflowDef) => req<{ issues: ValidationIssue[] }>('POST', '/api/workflows/validate', { def }),
    run: (id: string, body: { mode: 'production' | 'test'; inputs: Record<string, InputValue>; fault?: FaultInjection; options?: RunOptions }) => req<Run>('POST', `/api/workflows/${id}/runs`, body),
  },
  reviews: {
    inbox: () => req<ReviewInbox>('GET', '/api/reviews'),
    get: (id: string) => req<ReviewDetail>('GET', `/api/reviews/${id}`),
    decide: (id: string, body: { decision: 'approved' | 'rejected'; comment?: string; attestation?: { approverName: string; approverQualification: string; attested: boolean; reviewDueAt: string } }) =>
      req<ReviewRequestView>('POST', `/api/reviews/${id}/decide`, body),
    withdraw: (id: string) => req<ReviewRequestView>('POST', `/api/reviews/${id}/withdraw`),
  },
  documents: {
    list: () => req<DocumentSummary[]>('GET', '/api/documents'),
    get: (id: string) => req<MaterialDocument>('GET', `/api/documents/${id}`),
    upload: (file: File) => upload<DocumentSummary>(`/api/documents?filename=${encodeURIComponent(file.name)}`, file),
    remove: (id: string) => req<{ ok: true }>('DELETE', `/api/documents/${id}`),
    fileUrl: (id: string) => `/api/documents/${id}/file`,
  },
  runs: {
    list: (workflowId?: string) => req<RunSummary[]>('GET', `/api/runs${q({ workflowId })}`),
    get: (id: string) => req<Run>('GET', `/api/runs/${id}`),
    rerun: (id: string) => req<Run>('POST', `/api/runs/${id}/rerun`, {}),
    retry: (id: string) => req<Run>('POST', `/api/runs/${id}/retry`, {}),
    cancel: (id: string) => req<Run>('POST', `/api/runs/${id}/cancel`, {}),
    addMissed: (id: string, m: { nodeId: string; ruleId: string; quote: string; issue: string }) => req<MissedFinding[]>('POST', `/api/runs/${id}/missed`, m),
    removeMissed: (id: string, mid: string) => req<MissedFinding[]>('DELETE', `/api/runs/${id}/missed/${mid}`),
    decide: (id: string, nodeId: string, decision: 'approved' | 'rejected', comment?: string) => req<Run>('POST', `/api/runs/${id}/nodes/${nodeId}/decision`, { decision, comment }),
    review: (id: string, nodeId: string, location: string, decision: ReviewDecision | null, note?: string, edits?: Record<string, string>) =>
      req<Record<string, ReviewMark>>('PUT', `/api/runs/${id}/reviews`, { nodeId, location, decision, note, edits }),
    exportUrl: (id: string, format: 'md' | 'json') => `/api/runs/${id}/export?format=${format}`,
    eventsUrl: (id: string) => `/api/runs/${id}/events`,
  },
  conversations: {
    list: () => req<ConversationSummary[]>('GET', '/api/conversations'),
    create: (body: { title?: string; workflowId?: string } = {}) => req<Conversation>('POST', '/api/conversations', body),
    get: (id: string) => req<Conversation>('GET', `/api/conversations/${id}`),
    update: (id: string, body: { title?: string; workflowId?: string }) => req<Conversation>('PATCH', `/api/conversations/${id}`, body),
    remove: (id: string) => req<{ ok: true }>('DELETE', `/api/conversations/${id}`),
    send: (id: string, body: { mode: ChatMode; text: string; workflowId?: string; attachments?: { documentId: string }[]; inputs?: Record<string, string>; runId?: string; rerunOf?: string; thinking?: boolean }) =>
      req<ChatSendResult>('POST', `/api/conversations/${id}/messages`, body),
    cancel: (id: string) => req<{ ok: true }>('POST', `/api/conversations/${id}/cancel`, {}),
    eventsUrl: (id: string) => `/api/conversations/${id}/events`,
  },
  admin: {
    users: () => req<User[]>('GET', '/api/admin/users'),
    createUser: (u: { email: string; name: string; role: Role; title?: string; password: string }) => req<User>('POST', '/api/admin/users', u),
    updateUser: (id: string, patch: Partial<Pick<User, 'name' | 'role' | 'title' | 'disabled'>> & { password?: string }) => req<User>('PATCH', `/api/admin/users/${id}`, patch),
    updatePolicy: (p: OrgPolicy) => req<Me>('PUT', '/api/admin/policy', p),
    audit: (limit = 300) => req<AuditEvent[]>('GET', `/api/admin/audit?limit=${limit}`),
    platform: () => req<PlatformInfo>('GET', '/api/admin/platform'),
  },
};
