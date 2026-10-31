import { useRef, useState } from 'react';
import { splitHint } from '../../shared/hints';
import type { DocumentSummary, InputField, SampleMaterial } from '../../shared/types';
import { api, type InputValue, openFile } from '../api';
import { AutoTextarea, ErrorNotice, useLoad } from './ui';

export type FormValue = string | { documentId: string; summary?: DocumentSummary };
export type FormValues = Record<string, FormValue>;

export const toApiInputs = (v: FormValues): Record<string, InputValue> =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : { documentId: x.documentId }]));

const METHOD: Record<string, string> = { 'text-layer': 'PDF 文字层', docx: 'Word 文本', ocr: '图片 OCR', plain: '纯文本' };
const ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.md';

export function DocumentCard({ doc, onClear }: { doc: DocumentSummary; onClear?: () => void }) {
  const conf = doc.ocrConfidence;
  return (
    <div className="doc-card" data-testid="document-card">
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>{doc.filename}</strong>
          <span className="small muted" style={{ marginLeft: 8 }}>
            {METHOD[doc.method] ?? doc.method} · {doc.pageCount} 页 · {doc.chars.toLocaleString()} 字符{conf !== undefined ? ` · OCR 置信度 ${conf}%` : ''}
          </span>
        </div>
        <div className="row">
          {doc.kind !== 'text' && <OpenOriginal id={doc.id} />}
          {onClear && (
            <button type="button" className="sm" onClick={onClear}>
              更换
            </button>
          )}
        </div>
      </div>
      {doc.preview && <div className="doc-preview">{doc.preview}…</div>}
      {doc.warnings.length > 0 && (
        <ul className="doc-warn" data-testid="document-warnings">
          {doc.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Opens the stored original in a new tab (fetched with this tab's session). */
export function OpenOriginal({ id, label = '查看原件' }: { id: string; label?: string }) {
  const [error, setError] = useState<unknown>();
  return (
    <>
      <button type="button" className="btn sm" onClick={() => openFile(api.documents.fileUrl(id)).catch(setError)} data-testid="open-original">
        {label}
      </button>
      {error ? <ErrorNotice error={error} /> : null}
    </>
  );
}

/** Material input: upload PDF / Word / image (parsed server-side, OCR for images) or paste text. */
export function DocumentInput({ value, onChange, invalid, testId }: { value: FormValue | undefined; onChange: (v: FormValue) => void; invalid?: boolean; testId: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [drag, setDrag] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      const doc = await api.documents.upload(file);
      onChange({ documentId: doc.id, summary: doc });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (value && typeof value !== 'string') {
    return value.summary ? <DocumentCard doc={value.summary} onClear={() => onChange('')} /> : <div className="doc-card">文档 {value.documentId}</div>;
  }
  return (
    <div
      className={`doc-drop ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) upload(f);
      }}
    >
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <button type="button" className="sm" onClick={() => fileRef.current?.click()} disabled={busy} data-testid={`${testId}-upload`}>
          {busy ? '正在解析…' : '上传文件'}
        </button>
        <span className="small muted">PDF / Word(.docx) / 图片（OCR）/ TXT，≤ 20MB；也可拖入文件，或直接在下方粘贴文字</span>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          hidden
          data-testid={`${testId}-file`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = '';
          }}
        />
      </div>
      <textarea className={`doc ${invalid ? 'invalid' : ''}`} rows={8} data-testid={testId} value={value ?? ''} placeholder="粘贴材料文字…" onChange={(e) => onChange(e.target.value)} />
      <ErrorNotice error={error} />
    </div>
  );
}

/** Runtime input form for a skill or workflow; document inputs get upload support. */
export function InputsForm({
  defs,
  values,
  onChange,
  invalid = [],
  testIdPrefix = 'input',
}: {
  defs: InputField[];
  values: FormValues;
  onChange: (v: FormValues) => void;
  invalid?: string[];
  testIdPrefix?: string;
}) {
  return (
    <div>
      {defs.map((d) => {
        const bad = invalid.includes(d.key);
        const set = (v: FormValue) => onChange({ ...values, [d.key]: v });
        const v = values[d.key];
        const hint = d.type === 'document' ? { help: d.description } : splitHint(d.description, d.defaultValue);
        const helpId = hint.help ? `${testIdPrefix}-${d.key}-help` : undefined;
        return (
          <div className="field" key={d.key}>
            <span className="lbl">
              {d.label || d.key}
              {d.required && <em>*</em>}
              <span className="mono muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                {d.key}
              </span>
            </span>
            {d.type === 'document' ? (
              <DocumentInput value={v} onChange={set} invalid={bad} testId={`${testIdPrefix}-${d.key}`} />
            ) : d.type === 'long_text' ? (
              <AutoTextarea
                className={`doc ${bad ? 'invalid' : ''}`}
                minRows={4}
                maxRows={16}
                aria-label={d.label}
                aria-describedby={helpId}
                data-testid={`${testIdPrefix}-${d.key}`}
                value={typeof v === 'string' ? v : ''}
                placeholder={hint.placeholder}
                onChange={(e) => set(e.target.value)}
              />
            ) : (
              <input
                type="text"
                aria-label={d.label}
                aria-describedby={helpId}
                className={bad ? 'invalid' : ''}
                data-testid={`${testIdPrefix}-${d.key}`}
                value={typeof v === 'string' ? v : ''}
                placeholder={hint.placeholder}
                onChange={(e) => set(e.target.value)}
              />
            )}
            {bad && <div className="field-error">此项为必填。</div>}
            {hint.help && (
              <div className="field-help" id={helpId}>
                {hint.help}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Fills the form from bundled fictional samples (text or files, which are uploaded and parsed). */
export function SamplePicker({ defs, values, onChange }: { defs: InputField[]; values: FormValues; onChange: (v: FormValues) => void }) {
  const samples = useLoad(() => api.samples(), []);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>();
  const docKey = defs.find((d) => d.type === 'document')?.key ?? defs.find((d) => d.type === 'long_text')?.key;
  async function use(s: SampleMaterial) {
    setError(undefined);
    const keys = new Set(defs.map((d) => d.key));
    const next: FormValues = { ...values };
    for (const [k, v] of Object.entries(s.inputs)) {
      if (keys.has(k)) next[k] = v;
      else if (k === 'material' && docKey) next[docKey] = v;
    }
    if (s.file) {
      if (!docKey) return;
      setBusy(s.id);
      try {
        const doc = await api.sampleDocument(s.id);
        next[docKey] = { documentId: doc.id, summary: doc };
      } catch (e) {
        setError(e);
        return;
      } finally {
        setBusy('');
      }
    }
    onChange(next);
  }
  if (!samples.data?.length) return null;
  return (
    <div className="samples" data-testid="sample-picker">
      <span className="small muted">示例材料（均为虚构）：</span>
      {samples.data.map((s) => (
        <button key={s.id} type="button" className="sm" title={s.description} onClick={() => use(s)} disabled={!!busy || (!!s.file && !docKey)} data-testid={`sample-${s.id}`}>
          {busy === s.id ? '解析中…' : s.title}
        </button>
      ))}
      <ErrorNotice error={error} />
    </div>
  );
}
