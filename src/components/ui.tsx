import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type DependencyList, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { ROLE_LABEL } from '../../shared/schema';
import type { LifecycleStatus, Me, Meta, NodeStatus, RulePackStatus, RunStatus, ValidationIssue, Verdict } from '../../shared/types';
import { ApiError } from '../api';

// ---------- toasts ----------
type Toast = { id: number; text: string; kind: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- meta & session ----------
export const MetaCtx = createContext<Meta | null>(null);
export const useMeta = () => useContext(MetaCtx);

export interface AuthState {
  me: Me;
  setMe: (me: Me) => void;
  logout: () => void;
  /** true when the action is allowed outright (not "ask", not "deny") */
  can: (action: string) => boolean;
}
export const AuthCtx = createContext<AuthState | null>(null);
export const useAuth = () => useContext(AuthCtx)!;

// ---------- data loading ----------
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    return fn()
      .then((d) => {
        if (n === seq.current) (setData(d), setError(undefined));
        return d;
      })
      .catch((e) => {
        if (n === seq.current) setError(e);
        return undefined;
      })
      .finally(() => n === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}

// ---------- errors ----------
export function ErrorNotice({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const e = error as ApiError & { hint?: string; details?: { issues?: unknown[] } };
  const issues = (e.details as { issues?: (string | ValidationIssue)[] } | undefined)?.issues;
  return (
    <div className="notice error" data-testid="error-notice" role="alert">
      <div className="title">{title ?? e.message ?? String(error)}</div>
      {title && <div>{e.message}</div>}
      {e.hint && <div className="hint">{e.hint}</div>}
      {Array.isArray(issues) && issues.length > 1 && (
        <ul>
          {issues.map((i, n) => (
            <li key={n}>{typeof i === 'string' ? i : i.message}</li>
          ))}
        </ul>
      )}
      {e.code && <div className="small muted" style={{ marginTop: 6 }}>错误代码：{e.code}</div>}
    </div>
  );
}

// ---------- status badges ----------
const STATUS_LABEL: Record<RunStatus | NodeStatus, string> = {
  queued: '排队中',
  pending: '等待',
  running: '运行中',
  waiting_approval: '等待审批',
  succeeded: '成功',
  failed: '失败',
  skipped: '已跳过',
  rejected: '已驳回',
};
export function StatusBadge({ status }: { status: RunStatus | NodeStatus }) {
  const cls = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : status === 'running' || status === 'queued' ? 'run' : status === 'waiting_approval' ? 'warn' : status === 'rejected' ? 'bad' : '';
  return (
    <span className={`badge ${cls}`} data-testid={`status-${status}`}>
      <span className="dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: 'real' | 'mock' }) {
  return mode === 'mock' ? <span className="badge mock">模拟模式</span> : <span className="badge ok">真实模型</span>;
}

export function RunModeBadge({ mode }: { mode: 'production' | 'test' }) {
  return mode === 'test' ? <span className="badge warn" title="使用草稿配置，结果仅供调试">测试运行</span> : <span className="badge">正式运行</span>;
}

/** Lifecycle of skills / workflows / rule packs: draft → in review → published / approved (→ expired). */
export function LifecycleBadge({ status, version, dirty }: { status: LifecycleStatus | RulePackStatus; version?: number; dirty?: boolean }) {
  const map: Record<string, [string, string]> = {
    draft: ['草稿', ''],
    in_review: ['审核中', 'warn'],
    published: [`已发布${version ? ` v${version}` : ''}`, 'ok'],
    approved: [`已批准${version ? ` v${version}` : ''}`, 'ok'],
    expired: ['审核已过期', 'bad'],
  };
  const [label, cls] = map[status] ?? [status, ''];
  return (
    <span className="row" style={{ gap: 6, display: 'inline-flex' }}>
      <span className={`badge ${cls}`} data-testid={`lifecycle-${status}`}>
        {label}
      </span>
      {dirty && status !== 'draft' && <span className="badge" title="草稿有尚未发布/批准的修改">草稿有改动</span>}
    </span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  return <span className={`badge role-${role}`}>{ROLE_LABEL[role] ?? role}</span>;
}

const VERDICT: Record<Verdict, [string, string]> = {
  supported: ['有依据', 'ok'],
  partially_supported: ['部分有依据', 'warn'],
  unsupported: ['依据不足', 'bad'],
  needs_facts: ['需补充事实', 'warn'],
  not_checked: ['未经代理核验', ''],
};
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const [label, cls] = VERDICT[verdict];
  return (
    <span className={`badge ${cls}`} data-testid={`verdict-${verdict}`}>
      {label}
    </span>
  );
}

export function IssuesList({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return <div className="notice ok small">配置检查通过。</div>;
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  return (
    <div className="stack" data-testid="workflow-issues">
      {errors.length > 0 && (
        <div className="notice error small">
          <div className="title">有 {errors.length} 处配置错误，修正后才能运行或提交发布</div>
          <ul>{errors.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="notice warn small">
          <div className="title">{warnings.length} 条提醒</div>
          <ul>{warnings.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ---------- helpers ----------
export function fmtTime(iso?: string) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function fmtDate(iso?: string) {
  return iso ? iso.slice(0, 10) : '-';
}
export function fmtDuration(start?: string, end?: string, ms?: number) {
  const v = ms ?? (start && end ? new Date(end).getTime() - new Date(start).getTime() : undefined);
  if (v === undefined || Number.isNaN(v)) return '-';
  return v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`;
}

/** Warns before closing/reloading the tab when there are unsaved changes. */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const fn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [dirty]);
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="empty">{text}</div>;
}

/** Small explanatory callout used to make governance rules visible where they apply. */
export function Explain({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'warn' }) {
  return <div className={`notice ${kind} small`}>{children}</div>;
}

/**
 * Textarea that grows with its content (between minRows and maxRows, then scrolls), so long text is never
 * hidden behind a fixed-height box or a single-line input. Re-measures when its width changes.
 */
export function AutoTextarea({ minRows = 1, maxRows = 10, className = '', value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [capped, setCapped] = useState(false);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 21;
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = 'auto';
    const max = maxRows * line + pad + border;
    const needed = el.scrollHeight + border;
    el.style.height = `${Math.min(max, Math.max(minRows * line + pad + border, needed))}px`;
    setCapped(needed > max + 1);
  }, [minRows, maxRows]);
  useLayoutEffect(fit, [fit, value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  return <textarea ref={ref} rows={minRows} className={`auto${capped ? ' capped' : ''}${className ? ` ${className}` : ''}`} value={value} {...rest} />;
}
