import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { GroundingResult, OutputField, ReviewDecision, ReviewMark, SecurityReport, TranscriptEntry, VerificationItem, VerificationResult } from '../../shared/types';
import { VerdictBadge } from './ui';

/**
 * AI output is untrusted: images are never loaded (a URL like https://evil.example/?d=<data> would be
 * requested by the reviewer's browser), and links show their real destination.
 */
const SAFE_MD: Components = {
  img: ({ alt, src }) => (
    <span className="blocked-img" title={src ? `未加载：${String(src).slice(0, 200)}` : undefined} data-testid="blocked-image">
      [图片未加载{alt ? `：${alt}` : ''}]
    </span>
  ),
  a: ({ href, children }) => {
    const url = String(href ?? '');
    const external = /^https?:\/\//i.test(url);
    if (!external) return <span>{children}</span>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow" title={url}>
        {children}
        <span className="small muted"> （{url.replace(/^https?:\/\//i, '').slice(0, 60)}）</span>
      </a>
    );
  },
};

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={SAFE_MD} skipHtml>
      {children}
    </ReactMarkdown>
  );
}

type Mark = { found: boolean; label: string; source: string; page?: number; match?: 'exact' | 'fuzzy' };
type GroundMap = Map<string, Mark[]>;

function groundMap(grounding?: GroundingResult[]): GroundMap {
  const m: GroundMap = new Map();
  for (const g of grounding ?? []) {
    for (const it of g.items) {
      const arr = m.get(it.location) ?? [];
      arr.push({ found: it.found, label: g.label, source: g.sourceLabel, page: it.page, match: it.match });
      m.set(it.location, arr);
    }
  }
  return m;
}

function GroundMark({ marks }: { marks?: Mark[] }) {
  if (!marks?.length) return null;
  const bad = marks.filter((x) => !x.found);
  if (bad.length) {
    return (
      <span className="ground bad" title={`未在${bad[0].source}中找到：可能是 AI 改写或编造，请人工核对`} data-testid="ground-bad">
        ⚠ {bad[0].label}未通过
      </span>
    );
  }
  const m = marks[0];
  if (m.match === 'fuzzy') {
    return (
      <span className="ground warn" title={`只在${m.source}中找到近似文字（OCR 识别可能有误），请对照原件核实后再采用`} data-testid="ground-fuzzy">
        ≈ {m.label}：近似匹配，需核实{m.page ? ` · 第 ${m.page} 页` : ''}
      </span>
    );
  }
  return (
    <span className="ground ok" title={`已在${m.source}中找到原文`} data-testid="ground-ok">
      ✓ {m.label}
      {m.page ? ` · 第 ${m.page} 页` : ''}
    </span>
  );
}

function VerificationMark({ v }: { v?: VerificationItem }) {
  if (!v) return null;
  const notes = [
    !v.ruleExists && `规则「${v.ruleId}」不在规则包中`,
    !v.quoteFound && '引文未在材料中找到',
    v.quoteFound && v.quoteMatch === 'fuzzy' && '引文只是 OCR 近似匹配，请对照原件核实',
    v.applicabilityNote,
    v.severityNote,
  ].filter(Boolean) as string[];
  return (
    <div className={`verify ${v.needsHumanReview ? 'flag' : ''}`} data-testid="verification-mark">
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="small" style={{ fontWeight: 600 }}>结论核验</span>
        <VerdictBadge verdict={v.verdict} />
        {v.needsHumanReview ? (
          <span className="badge warn" data-testid="needs-review" title="确定性检查未通过，或核验代理未完全支持该结论">
            优先复核
          </span>
        ) : (
          <span className="badge" title="核验未发现问题，但 AI 核查 AI 不能代替人工判断，仍需人工确认">
            常规复核
          </span>
        )}
        {v.ruleTitle && <span className="small muted">规则：{v.ruleId} {v.ruleTitle}</span>}
      </div>
      {(v.reason || notes.length > 0 || (Array.isArray(v.missingFacts) && v.missingFacts.length > 0)) && (
        <ul className="verify-notes">
          {v.reason && <li>核验代理：{String(v.reason)}</li>}
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
          {Array.isArray(v.missingFacts) && v.missingFacts.length ? <li>需补充的事实：{v.missingFacts.map(String).join('；')}</li> : null}
        </ul>
      )}
    </div>
  );
}

const isQuoteKey = (k: string) => /quote|evidence|excerpt|原文/i.test(k);
const RISK: Record<string, string> = { high: 'bad', medium: 'warn', low: 'ok' };

function Scalar({ field, value }: { field?: OutputField; value: unknown }) {
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (field?.type === 'enum' && typeof value === 'string') return <span className={`badge ${RISK[value] ?? ''}`}>{value}</span>;
  if (Array.isArray(value)) {
    return value.length ? (
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {value.map((v, i) => (
          <li key={i}>{typeof v === 'string' ? v : JSON.stringify(v)}</li>
        ))}
      </ul>
    ) : (
      <span className="muted">（无）</span>
    );
  }
  if (value === null || value === undefined || value === '') return <span className="muted">（空）</span>;
  return <span style={{ whiteSpace: 'pre-wrap' }}>{typeof value === 'string' ? value : JSON.stringify(value)}</span>;
}

export type ReviewHandler = (location: string, decision: ReviewDecision | null, extra?: { edits?: Record<string, string>; note?: string }) => void;

export interface OutputViewProps {
  value: unknown;
  format: 'markdown' | 'json';
  fields?: OutputField[];
  grounding?: GroundingResult[];
  verification?: VerificationResult;
  /** Enables per-item human review (accept / edit / reject) for object lists. */
  nodeId?: string;
  reviews?: Record<string, ReviewMark>;
  onReview?: ReviewHandler;
}

const MARK_LABEL: Record<ReviewDecision, string> = { accepted: '已采纳', edited: '修改后采纳', rejected: '已驳回' };

/** Inline correction form: the reviewer fixes fields of a finding that is right in substance. */
function EditForm({ row, fields, initial, onSave, onCancel }: { row: Record<string, unknown>; fields?: OutputField[]; initial?: Record<string, string>; onSave: (edits: Record<string, string>, note: string) => void; onCancel: () => void }) {
  const editable = Object.entries(row).filter(([k, v]) => !isQuoteKey(k) && (typeof v === 'string' || typeof v === 'number'));
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(editable.map(([k, v]) => [k, initial?.[k] ?? String(v ?? '')])));
  const [note, setNote] = useState('');
  const changed = Object.fromEntries(Object.entries(vals).filter(([k, v]) => v !== String(row[k] ?? '')));
  return (
    <div className="edit-form" data-testid="edit-form">
      {editable.map(([k]) => {
        const f = fields?.find((x) => x.key === k);
        return (
          <label key={k} className="field">
            <span className="lbl">{f?.label || k}</span>
            {f?.type === 'enum' && f.options?.length ? (
              <select value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} data-testid={`edit-${k}`}>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <textarea rows={String(vals[k]).length > 80 ? 3 : 1} value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} data-testid={`edit-${k}`} />
            )}
          </label>
        );
      })}
      <label className="field">
        <span className="lbl">修改说明（可选）</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} data-testid="edit-note" />
      </label>
      <div className="row">
        <button type="button" className="primary sm" disabled={!Object.keys(changed).length} onClick={() => onSave(changed, note)} data-testid="edit-save">
          保存为“修改后采纳”
        </button>
        <button type="button" className="sm" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function ReviewItem({ row, i, loc, fields, gm, ver, mark, onReview }: { row: Record<string, unknown>; i: number; loc: string; fields?: OutputField[]; gm: GroundMap; ver?: VerificationItem; mark?: ReviewMark; onReview?: ReviewHandler }) {
  const [editing, setEditing] = useState(false);
  const quoteEntries = Object.entries(row).filter(([k]) => isQuoteKey(k));
  const rest = Object.entries(row).filter(([k]) => !isQuoteKey(k));
  const fieldOf = (key: string) => fields?.find((f) => f.key === key);
  return (
    <div className={`it ${mark?.decision ?? ''} ${ver?.needsHumanReview ? 'flagged' : ''}`} data-testid="output-item">
      <div className="it-head">
        <span className="small muted">#{i + 1}</span>
        {mark && (
          <span className="small muted">
            {MARK_LABEL[mark.decision]} · {mark.byName}
            {mark.note ? ` · ${mark.note}` : ''}
          </span>
        )}
        {onReview && (
          <span className="review" aria-label="人工复核">
            <button type="button" className={`sm ${mark?.decision === 'accepted' ? 'on-accept' : ''}`} onClick={() => onReview(loc, mark?.decision === 'accepted' ? null : 'accepted')} data-testid="review-accept">
              采纳
            </button>
            <button type="button" className={`sm ${mark?.decision === 'edited' ? 'on-edit' : ''}`} onClick={() => setEditing((x) => !x)} data-testid="review-edit">
              修改
            </button>
            <button type="button" className={`sm ${mark?.decision === 'rejected' ? 'on-reject' : ''}`} onClick={() => onReview(loc, mark?.decision === 'rejected' ? null : 'rejected')} data-testid="review-reject">
              驳回
            </button>
          </span>
        )}
      </div>
      {quoteEntries.map(([k, q]) => {
        const marks = gm.get(`${loc}.${k}`);
        const bad = marks?.some((x) => !x.found);
        return (
          <div key={k} className={`quote ${bad ? 'unverified' : ''}`}>
            <mark>{String(q ?? '')}</mark>
            <GroundMark marks={marks} />
          </div>
        );
      })}
      <div className="kv" style={{ marginTop: quoteEntries.length ? 8 : 0 }}>
        {rest.map(([k, cv]) => {
          const sf = fieldOf(k);
          return (
            <div key={k} style={{ display: 'contents' }}>
              <div className="k">{sf?.label || k}</div>
              <div>
                <Scalar field={sf} value={cv} />
                <GroundMark marks={gm.get(`${loc}.${k}`)} />
              </div>
            </div>
          );
        })}
      </div>
      {mark?.decision === 'edited' && mark.edits && (
        <div className="edits" data-testid="edits">
          复核人修改：
          {Object.entries(mark.edits).map(([k, v]) => (
            <div key={k}>
              {fieldOf(k)?.label || k} → {v}
            </div>
          ))}
        </div>
      )}
      {editing && onReview && (
        <EditForm
          row={row}
          fields={fields}
          initial={mark?.edits}
          onCancel={() => setEditing(false)}
          onSave={(edits, note) => {
            onReview(loc, 'edited', { edits, note });
            setEditing(false);
          }}
        />
      )}
      <VerificationMark v={ver} />
    </div>
  );
}

/** Renders a skill output: Markdown as a document; JSON generically (lists of records as reviewable items). */
export default function OutputView({ value, format, fields, grounding, verification, nodeId, reviews, onReview }: OutputViewProps) {
  if (format === 'markdown' || typeof value === 'string') {
    return (
      <div className="doc" data-testid="output-markdown">
        <SafeMarkdown>{String(value ?? '')}</SafeMarkdown>
      </div>
    );
  }
  if (!value || typeof value !== 'object') return <div className="muted">（无输出）</div>;
  const gm = groundMap(grounding);
  const fieldOf = (key: string, list = fields) => list?.find((f) => f.key === key);
  const vmap = new Map((verification?.items ?? []).map((v) => [v.location, v]));

  return (
    <div data-testid="output-json">
      {Object.entries(value as Record<string, unknown>).map(([key, v]) => {
        const f = fieldOf(key);
        const title = f?.label || key;
        const isRecords = Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
        if (!isRecords) {
          return (
            <div key={key}>
              <div className="out-key">{title}</div>
              <div>
                <Scalar field={f} value={v} />
                <GroundMark marks={gm.get(key)} />
              </div>
            </div>
          );
        }
        const rows = v as Record<string, unknown>[];
        return (
          <div key={key}>
            <div className="out-key">
              {title}（{rows.length}）
            </div>
            <div className="items">
              {rows.map((row, i) => {
                const loc = `${key}[${i}]`;
                return <ReviewItem key={i} row={row} i={i} loc={loc} fields={f?.fields} gm={gm} ver={vmap.get(loc)} mark={nodeId ? reviews?.[`${nodeId}|${loc}`] : undefined} onReview={onReview} />;
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One-line summary of grounding results, e.g. "声明引文核对 5/6". */
export function GroundingSummary({ grounding }: { grounding?: GroundingResult[] }) {
  if (!grounding?.length) return null;
  return (
    <>
      {grounding.map((g) => (
        <span key={g.checkId} className={`badge ${g.note ? '' : g.passed === g.total ? 'ok' : 'bad'}`} title={g.note ?? `${g.sourceLabel}：${g.passed}/${g.total} 项可在来源中找到`} data-testid="grounding-badge">
          {g.label} {g.note ? '未执行' : `${g.passed}/${g.total}`}
        </span>
      ))}
    </>
  );
}

export function VerificationSummary({ v }: { v?: VerificationResult }) {
  if (!v) return null;
  const s = v.summary;
  return (
    <span
      className={`badge ${s.flagged ? 'warn' : ''}`}
      data-testid="verification-badge"
      title={`${v.agentUsed ? '确定性检查 + 只读核验代理' : '仅确定性检查（未使用核验代理）'}。核验只决定复核顺序，所有发现都需人工确认。`}
    >
      结论核验：{s.flagged} 条优先复核 · {v.items.length - s.flagged} 条常规复核
    </span>
  );
}

/** What the guards did around the model call (pseudonymisation, injection, leak, external images). */
export function SecurityNotes({ s }: { s?: SecurityReport }) {
  if (!s) return null;
  const items = [
    s.pseudonymized && `发送模型前已假名化：${s.pseudonymized}（结果中已还原）`,
    s.visionWithheld?.length && `含个人信息的原件未发送给模型：${s.visionWithheld.join('、')}`,
    s.injectionSuspected?.length && `材料含疑似提示注入语句：${s.injectionSuspected.map((x) => `“${x}”`).join('、')}（已按数据处理）`,
    s.externalImagesRemoved && `已移除输出中的 ${s.externalImagesRemoved} 个外部图片`,
    s.leakBlocked && `输出被拦截：${s.leakBlocked}`,
  ].filter(Boolean) as string[];
  if (!items.length) return null;
  return (
    <div className={`notice ${s.leakBlocked ? 'error' : 'info'} small`} data-testid="security-notes" style={{ marginBottom: 10 }}>
      <strong>安全防护</strong>
      <ul style={{ margin: '4px 0 0' }}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

const ENTRY_ICON: Record<TranscriptEntry['type'], string> = { assistant_text: '💬', tool_call: '🔧', tool_result: '↩', permission: '🔒', hook: '🪝', note: 'ℹ', thinking: '💭' };

/** The model's reasoning ("深度思考"), folded when long. */
export function ThinkingText({ text, label = '思考过程' }: { text: string; label?: string }) {
  const long = text.length > 280;
  return (
    <span className="te-text thinking" data-testid="thinking-entry">
      {long ? (
        <details>
          <summary>
            {label}：{text.slice(0, 120).replace(/\s+/g, ' ')}…
          </summary>
          <span className="thinking-full">{text}</span>
        </details>
      ) : (
        <>
          {label}：{text}
        </>
      )}
    </span>
  );
}

/** The agent's working record: model text, tool calls and results, permission decisions, hook notes. */
export function Transcript({ entries }: { entries?: TranscriptEntry[] }) {
  if (!entries?.length) return <div className="muted small">没有记录（模型未调用工具，或节点尚未运行）。</div>;
  return (
    <ol className="transcript" data-testid="transcript">
      {entries.map((e, i) => (
        <li key={i} className={`te te-${e.type} ${'ok' in e && !e.ok ? 'bad' : ''}`}>
          <span className="te-icon" aria-hidden>
            {ENTRY_ICON[e.type]}
          </span>
          <span className="te-turn">第 {e.turn} 轮</span>
          {e.type === 'assistant_text' && <span className="te-text">{e.text}</span>}
          {e.type === 'tool_call' && (
            <span className="te-text">
              调用 <code>{e.name}</code> <span className="mono muted">{JSON.stringify(e.input)?.slice(0, 220)}</span>
            </span>
          )}
          {e.type === 'tool_result' && (
            <span className="te-text">
              <code>{e.name}</code> {e.ok ? '→' : '✗'} {e.summary}
            </span>
          )}
          {e.type === 'permission' && (
            <span className="te-text">
              工具 <code>{e.tool}</code>：{e.decision === 'ask' ? '需要人工批准' : e.decision === 'deny' ? '被组织策略禁止' : '允许'}
              {e.reason ? `（${e.reason}）` : ''}
            </span>
          )}
          {e.type === 'hook' && (
            <span className="te-text">
              <code>{e.hook}</code> {e.message}
            </span>
          )}
          {e.type === 'note' && <span className="te-text">{e.message}</span>}
          {e.type === 'thinking' && <ThinkingText text={e.text} label={e.agent === 'verifier' ? '核验代理的思考' : '思考过程'} />}
        </li>
      ))}
    </ol>
  );
}
