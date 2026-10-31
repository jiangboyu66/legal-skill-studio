import { type ReactNode, useEffect, useState } from 'react';
import { KEY_PATTERN, listGroundablePaths } from '../../shared/schema';
import type { GroundingCheck, InputField, OutputField, OutputFieldType, Rule, RulePackView, SourceVerification, ToolInfo, VerificationConfig } from '../../shared/types';
import { AutoTextarea, LifecycleBadge } from './ui';

function move<T>(arr: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const copy = [...arr];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

function nextKey(existing: string[], base: string) {
  let n = existing.length + 1;
  while (existing.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** A control with a short caption above it. Captions replace cramped header rows and long placeholders. */
function Cell({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`cell ${className}`}>
      <span className="cell-lbl">{label}</span>
      {children}
    </label>
  );
}

function RowTools({ onUp, onDown, onRemove, label }: { onUp: () => void; onDown: () => void; onRemove: () => void; label: string }) {
  return (
    <div className="tools">
      <button type="button" className="ghost sm" onClick={onUp} aria-label={`上移${label}`} title="上移">↑</button>
      <button type="button" className="ghost sm" onClick={onDown} aria-label={`下移${label}`} title="下移">↓</button>
      <button type="button" className="ghost sm danger" onClick={onRemove} aria-label={`删除${label}`} title="删除">✕</button>
    </div>
  );
}

// ---------- input fields (skill inputs & workflow inputs) ----------
export function InputFieldsEditor({ value, onChange, testId }: { value: InputField[]; onChange: (v: InputField[]) => void; testId?: string }) {
  const set = (i: number, patch: Partial<InputField>) => onChange(value.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  return (
    <div data-testid={testId}>
      <div className="rows cards">
        {value.map((f, i) => (
          <div className="r card" key={i}>
            <div className="line1 in">
              <Cell label="标识（英文）" className="c-key">
                <input
                  type="text"
                  aria-label="输入标识"
                  spellCheck={false}
                  className={KEY_PATTERN.test(f.key) ? 'mono' : 'mono invalid'}
                  value={f.key}
                  title={f.key}
                  onChange={(e) => set(i, { key: e.target.value.trim() })}
                  placeholder="material"
                />
              </Cell>
              <Cell label="显示名称" className="c-label">
                <input type="text" aria-label="显示名称" value={f.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="如：营销物料" />
              </Cell>
              <Cell label="类型" className="c-type">
                <select aria-label="输入类型" value={f.type} onChange={(e) => set(i, { type: e.target.value as InputField['type'] })}>
                  <option value="document">文档 / 材料</option>
                  <option value="long_text">多行文本</option>
                  <option value="text">单行文本</option>
                </select>
              </Cell>
              <label className="check tall c-req">
                <input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} /> 必填
              </label>
              <RowTools
                label={f.label || f.key}
                onUp={() => onChange(move(value, i, -1))}
                onDown={() => onChange(move(value, i, 1))}
                onRemove={() => onChange(value.filter((_, n) => n !== i))}
              />
            </div>
            <div className="line2">
              <Cell label="填写说明（显示在填写框下方，可选）">
                <AutoTextarea aria-label="填写说明" maxLength={500} maxRows={4} value={f.description ?? ''} onChange={(e) => set(i, { description: e.target.value || undefined })} />
              </Cell>
              <Cell label="默认值（可选）">
                <input type="text" aria-label="默认值" value={f.defaultValue ?? ''} onChange={(e) => set(i, { defaultValue: e.target.value || undefined })} />
              </Cell>
            </div>
          </div>
        ))}
        {!value.length && <div className="r muted small">还没有输入字段。</div>}
      </div>
      <button
        type="button"
        className="sm add-row"
        onClick={() => onChange([...value, { key: nextKey(value.map((f) => f.key), 'input'), label: '', type: 'long_text', required: false }])}
      >
        ＋ 添加输入字段
      </button>
      <div className="field-help">标识用于在工作流中连线，只能用小写字母、数字和下划线，并以字母开头。填写说明会显示在运行页面的输入框下方。</div>
    </div>
  );
}

// ---------- output fields ----------
const TYPE_LABEL: Record<OutputFieldType, string> = {
  string: '文本',
  number: '数字',
  boolean: '是 / 否',
  enum: '固定选项',
  string_list: '文本列表',
  object_list: '表格（多项）',
};

function OptionsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => {
    if (text.split(',').map((s) => s.trim()).filter(Boolean).join('|') !== value.join('|')) setText(value.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text"
      aria-label="可选值"
      value={text}
      placeholder="如：high, medium, low"
      className={value.length ? '' : 'invalid'}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

export function OutputFieldsEditor({
  value,
  onChange,
  nested = false,
  testId,
}: {
  value: OutputField[];
  onChange: (v: OutputField[]) => void;
  nested?: boolean;
  testId?: string;
}) {
  const set = (i: number, patch: Partial<OutputField>) => onChange(value.map((f, n) => (n === i ? { ...f, ...patch } : f)));
  const types = (Object.keys(TYPE_LABEL) as OutputFieldType[]).filter((t) => !nested || t !== 'object_list');
  return (
    <div data-testid={testId}>
      <div className="rows cards">
        {value.map((f, i) => (
          <div className="r card" key={i}>
            <div className="line1 out">
              <Cell label="标识（英文）" className="c-key">
                <input
                  type="text"
                  aria-label="字段标识"
                  spellCheck={false}
                  className={KEY_PATTERN.test(f.key) ? 'mono' : 'mono invalid'}
                  value={f.key}
                  title={f.key}
                  onChange={(e) => set(i, { key: e.target.value.trim() })}
                />
              </Cell>
              <Cell label="显示名称" className="c-label">
                <input type="text" aria-label="字段名称" value={f.label ?? ''} onChange={(e) => set(i, { label: e.target.value })} />
              </Cell>
              <Cell label="类型" className="c-type">
                <select
                  aria-label="字段类型"
                  value={f.type}
                  onChange={(e) => {
                    const type = e.target.value as OutputFieldType;
                    set(i, {
                      type,
                      options: type === 'enum' ? f.options ?? [] : undefined,
                      fields: type === 'object_list' ? f.fields ?? [{ key: 'item', label: '内容', type: 'string', required: true }] : undefined,
                    });
                  }}
                >
                  {types.map((t) => (
                    <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                  ))}
                </select>
              </Cell>
              <label className="check tall c-req">
                <input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} /> 必填
              </label>
              <RowTools
                label={f.label || f.key}
                onUp={() => onChange(move(value, i, -1))}
                onDown={() => onChange(move(value, i, 1))}
                onRemove={() => onChange(value.filter((_, n) => n !== i))}
              />
            </div>
            <div className={`line2${f.type === 'enum' ? '' : ' one'}`}>
              <Cell label="说明（告诉 AI 这个字段填什么，可选）">
                <AutoTextarea aria-label="字段说明" maxLength={500} maxRows={4} value={f.description ?? ''} onChange={(e) => set(i, { description: e.target.value || undefined })} />
              </Cell>
              {f.type === 'enum' && (
                <Cell label="可选值（逗号分隔）">
                  <OptionsInput value={f.options ?? []} onChange={(options) => set(i, { options })} />
                </Cell>
              )}
            </div>
            {f.type === 'object_list' && (
              <div className="nested">
                <div className="small muted" style={{ margin: '2px 0 6px' }}>「{f.label || f.key}」每一项包含的子字段：</div>
                <OutputFieldsEditor nested value={f.fields ?? []} onChange={(fields) => set(i, { fields })} />
              </div>
            )}
          </div>
        ))}
        {!value.length && <div className="r muted small">还没有输出字段。</div>}
      </div>
      <button
        type="button"
        className="sm add-row"
        onClick={() => onChange([...value, { key: nextKey(value.map((f) => f.key), nested ? 'sub' : 'field'), label: '', type: 'string', required: true }])}
      >
        ＋ 添加{nested ? '子' : ''}字段
      </button>
    </div>
  );
}

// ---------- grounding checks ----------
export function ChecksEditor({
  value,
  onChange,
  fields,
  inputs,
}: {
  value: GroundingCheck[];
  onChange: (v: GroundingCheck[]) => void;
  fields: OutputField[];
  inputs: InputField[];
}) {
  const paths = listGroundablePaths(fields);
  const set = (i: number, patch: Partial<GroundingCheck>) => onChange(value.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  return (
    <div data-testid="checks-editor">
      <div className="rows cards">
        {value.map((c, i) => (
          <div className="r card" key={c.id}>
            <div className="line1 chk">
              <Cell label="名称" className="c-name">
                <input type="text" aria-label="核对名称" value={c.label} onChange={(e) => set(i, { label: e.target.value })} />
              </Cell>
              <Cell label="要核对的输出字段" className="c-path">
                <select aria-label="核对字段" value={c.path} onChange={(e) => set(i, { path: e.target.value })} className={paths.some((p) => p.path === c.path) ? '' : 'invalid'} title={paths.find((p) => p.path === c.path)?.label}>
                  <option value="">选择字段…</option>
                  {paths.map((p) => (
                    <option key={p.path} value={p.path}>{p.label}（{p.path}）</option>
                  ))}
                </select>
              </Cell>
              <Cell label="必须出现在" className="c-src">
                <select aria-label="核对来源" value={c.source} onChange={(e) => set(i, { source: e.target.value })}>
                  <option value="knowledge">规则包（参考资料）</option>
                  {inputs.map((d) => (
                    <option key={d.key} value={`input:${d.key}`}>输入「{d.label || d.key}」</option>
                  ))}
                </select>
              </Cell>
              <div className="tools">
                <button type="button" className="ghost sm danger" onClick={() => onChange(value.filter((_, n) => n !== i))} aria-label="删除核对" title="删除">✕</button>
              </div>
            </div>
          </div>
        ))}
        {!value.length && <div className="r muted small">未设置核对。建议为“原文引文”和“规则编号”字段各加一条。</div>}
      </div>
      <button
        type="button"
        className="sm add-row"
        disabled={!paths.length}
        onClick={() =>
          onChange([
            ...value,
            {
              id: `chk_${Math.random().toString(36).slice(2, 8)}`,
              label: '引文核对',
              path: paths.find((p) => /quote|原文/.test(p.path))?.path ?? paths[0]?.path ?? '',
              source: inputs[0] ? `input:${inputs[0].key}` : 'knowledge',
            },
          ])
        }
      >
        ＋ 添加核对
      </button>
    </div>
  );
}

// ---------- rule packs, tools, verification ----------
export function RulePackPicker({ value, onChange, packs }: { value: string[]; onChange: (v: string[]) => void; packs: RulePackView[] }) {
  if (!packs.length) return <div className="muted small">组织中还没有规则包。</div>;
  return (
    <div className="pick-list" data-testid="rulepack-picker">
      {packs.map((p) => (
        <label key={p.id} className="pick">
          <input type="checkbox" checked={value.includes(p.id)} onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
          <span className="grow">
            <strong>{p.name}</strong> <span className="muted small">{p.jurisdiction} · {p.stats.total} 条规则</span>
          </span>
          <LifecycleBadge status={p.status} version={p.approvedVersion} dirty={p.dirty} />
        </label>
      ))}
    </div>
  );
}

const TOOL_LABEL: Record<string, string> = {
  read_document: '读取文档（按页）',
  search_document: '在文档中搜索',
  lookup_rule: '查阅规则全文与适用范围',
  verify_quote: '核对引文是否逐字出现',
};

export function ToolsPicker({ value, onChange, tools }: { value: string[]; onChange: (v: string[]) => void; tools: ToolInfo[] }) {
  return (
    <div className="pick-list" data-testid="tools-picker">
      {/* submit_output is added automatically for structured outputs */}
      {tools.filter((t) => t.name !== 'submit_output').map((t) => (
        <label key={t.name} className="pick" title={t.description}>
          <input type="checkbox" checked={value.includes(t.name)} onChange={(e) => onChange(e.target.checked ? [...value, t.name] : value.filter((x) => x !== t.name))} />
          <span className="grow">
            {TOOL_LABEL[t.name] ?? t.name} <code className="small">{t.name}</code>
          </span>
          {t.readOnly && <span className="badge">只读</span>}
        </label>
      ))}
    </div>
  );
}

export function VerificationEditor({ value, onChange, fields, inputs }: { value?: VerificationConfig; onChange: (v?: VerificationConfig) => void; fields: OutputField[]; inputs: InputField[] }) {
  const lists = fields.filter((f) => f.type === 'object_list');
  const enabled = !!value?.enabled;
  const list = lists.find((f) => f.key === value?.listPath) ?? lists[0];
  const sub = list?.fields ?? [];
  const guess = (re: RegExp) => sub.find((f) => re.test(f.key))?.key ?? sub[0]?.key ?? '';
  const v: VerificationConfig = value ?? {
    enabled: true,
    listPath: list?.key ?? '',
    ruleIdField: guess(/rule/),
    quoteField: guess(/quote/),
    conclusionField: guess(/issue|conclusion|why/),
    severityField: sub.find((f) => /risk|severity/.test(f.key))?.key,
    channelInput: inputs.find((i) => /channel/.test(i.key))?.key,
    useAgent: true,
  };
  const set = (patch: Partial<VerificationConfig>) => onChange({ ...v, ...patch, enabled: true });
  const sel = (label: string, key: keyof VerificationConfig, opts: { key: string; label?: string }[], optional = false) => (
    <label className="field" style={{ marginBottom: 8 }}>
      <span className="lbl">{label}</span>
      <select value={(v[key] as string) ?? ''} onChange={(e) => set({ [key]: e.target.value || undefined } as Partial<VerificationConfig>)}>
        {optional && <option value="">（不使用）</option>}
        {opts.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label || o.key}（{o.key}）
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div data-testid="verification-editor">
      <label className="check" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={enabled} disabled={!lists.length} onChange={(e) => onChange(e.target.checked ? { ...v, enabled: true } : undefined)} />
        启用结论核验{!lists.length && <span className="muted">（需要一个“对象列表”类型的输出字段，例如问题清单）</span>}
      </label>
      {enabled && (
        <div className="cols-2">
          {sel('问题列表字段', 'listPath', lists)}
          {sel('规则编号字段', 'ruleIdField', sub)}
          {sel('原文引文字段', 'quoteField', sub)}
          {sel('结论 / 问题说明字段', 'conclusionField', sub)}
          {sel('风险等级字段', 'severityField', sub, true)}
          {sel('投放渠道（用于判断规则适用范围）', 'channelInput', inputs, true)}
          <label className="check" style={{ gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={v.useAgent} onChange={(e) => set({ useAgent: e.target.checked })} /> 同时使用只读“核验代理”逐条尝试证伪结论（会增加一次模型调用）
          </label>
        </div>
      )}
    </div>
  );
}

// ---------- rule pack rules ----------
const CHANNELS: [string, string][] = [
  ['email', '邮件/EDM'], ['sms', '短信'], ['messaging', '即时通讯'], ['voice', '电话'], ['social', '社交媒体'], ['web', '网站'], ['print', '印刷品'], ['outdoor', '户外'],
];
const VERIF: Record<SourceVerification, string> = { verbatim: '原文已核对', paraphrased: '转述（待核对）', unverified: '未核实' };

export function RulesEditor({ value, onChange, readOnly }: { value: Rule[]; onChange: (v: Rule[]) => void; readOnly?: boolean }) {
  const set = (i: number, patch: Partial<Rule>) => onChange(value.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const setSrc = (i: number, patch: Partial<Rule['source']>) => set(i, { source: { ...value[i].source, ...patch } });
  return (
    <div className="rules" data-testid="rules-editor">
      {value.map((r, i) => (
        <fieldset className={`rule v-${r.source.verification}`} key={i} disabled={readOnly}>
          <div className="rule-head">
            <input type="text" aria-label="规则编号" className="mono" style={{ width: 120 }} value={r.id} onChange={(e) => set(i, { id: e.target.value.trim() })} />
            <input type="text" aria-label="规则标题" className="grow" value={r.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="规则标题" />
            <select aria-label="默认风险" value={r.severity} onChange={(e) => set(i, { severity: e.target.value as Rule['severity'] })} style={{ width: 110 }}>
              <option value="high">高风险</option>
              <option value="medium">中风险</option>
              <option value="low">低风险</option>
            </select>
            {!readOnly && (
              <RowTools label={r.id} onUp={() => onChange(move(value, i, -1))} onDown={() => onChange(move(value, i, 1))} onRemove={() => onChange(value.filter((_, n) => n !== i))} />
            )}
          </div>
          <Cell label="规则内容（AI 按此判断）">
            <AutoTextarea aria-label="规则内容" minRows={2} maxRows={8} value={r.text} onChange={(e) => set(i, { text: e.target.value })} />
          </Cell>
          <div className="rule-src">
            <Cell label="来源（法规 / 准则 / 内部政策及条款）">
              <input type="text" aria-label="来源" value={r.source.title} onChange={(e) => setSrc(i, { title: e.target.value })} placeholder="如：SCAP 第 3 条" />
            </Cell>
            <Cell label="链接（可选）">
              <input type="url" aria-label="来源链接" value={r.source.url ?? ''} onChange={(e) => setSrc(i, { url: e.target.value || undefined })} placeholder="https://…" />
            </Cell>
            <Cell label="核实程度">
              <select aria-label="核实程度" value={r.source.verification} onChange={(e) => setSrc(i, { verification: e.target.value as SourceVerification })}>
                {(Object.keys(VERIF) as SourceVerification[]).map((k) => (
                  <option key={k} value={k}>{VERIF[k]}</option>
                ))}
              </select>
            </Cell>
          </div>
          <Cell label={r.source.verification === 'verbatim' ? '来源原文摘录（必填：标注了“原文已核对”）' : '来源原文摘录（可选）'}>
            <AutoTextarea aria-label="来源原文摘录" maxRows={6} value={r.source.excerpt ?? ''} onChange={(e) => setSrc(i, { excerpt: e.target.value || undefined })} />
          </Cell>
          <div className="row wrap small" style={{ gap: 10, marginTop: 6 }}>
            <span className="muted">仅适用于渠道：</span>
            {CHANNELS.map(([k, label]) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={r.appliesTo?.channels?.includes(k) ?? false}
                  onChange={(e) => {
                    const cur = r.appliesTo?.channels ?? [];
                    const next = e.target.checked ? [...cur, k] : cur.filter((x) => x !== k);
                    set(i, { appliesTo: next.length ? { channels: next } : undefined });
                  }}
                />
                {label}
              </label>
            ))}
            <span className="muted">（不勾选 = 所有渠道）</span>
          </div>
        </fieldset>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="sm add-row"
          onClick={() => onChange([...value, { id: `R-${value.length + 1}`, title: '', text: '', severity: 'medium', source: { title: '', verification: 'unverified' } }])}
        >
          ＋ 添加规则
        </button>
      )}
    </div>
  );
}
