import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { emptySkillConfig } from '../../shared/schema';
import type { FaultType, SkillConfig, SkillTestResult, SkillView } from '../../shared/types';
import { api } from '../api';
import { ChecksEditor, InputFieldsEditor, OutputFieldsEditor, RulePackPicker, ToolsPicker, VerificationEditor } from '../components/editors';
import { type FormValues, InputsForm, SamplePicker, toApiInputs } from '../components/inputs';
import OutputView, { GroundingSummary, SecurityNotes, Transcript, VerificationSummary } from '../components/OutputView';
import EvalPanel from '../components/EvalPanel';
import { SkillOverview } from '../components/Overview';
import PublishPanel from '../components/PublishPanel';
import { AutoTextarea, ErrorNotice, Explain, fmtTime, LifecycleBadge, Loading, ModeBadge, useAuth, useLoad, useToast, useUnsavedWarning } from '../components/ui';

interface SkillForm {
  name: string;
  description: string;
  category?: string;
  jurisdiction?: string;
  config: SkillConfig;
}

const toForm = (s: SkillView): SkillForm => ({ name: s.name, description: s.description, category: s.category, jurisdiction: s.jurisdiction, config: s.draft });
const EMPTY: SkillForm = { name: '', description: '', config: emptySkillConfig() };

export const FAULT_OPTIONS: { value: FaultType; label: string }[] = [
  { value: 'none', label: '不注入（正常调用）' },
  { value: 'auth', label: '鉴权失败（401）' },
  { value: 'rate_limit', label: '限流（429，会自动重试）' },
  { value: 'timeout', label: '调用超时（会自动重试）' },
  { value: 'server_error', label: '服务不可用（503，会自动重试）' },
  { value: 'bad_output', label: '输出不合规（三次修正后仍失败）' },
  { value: 'bad_output_once', label: '输出不合规一次（自动修正成功）' },
];

/** 使用者 (no edit / approve right) get a read-only overview of the published Skill instead of the editor. */
export default function SkillEditor() {
  const { id } = useParams();
  const { can } = useAuth();
  if (id && !can('skill.edit') && !can('skill.approve')) return <SkillOverview id={id} />;
  return <SkillEditorPage />;
}

function SkillEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const platform = useLoad(() => api.admin.platform(), []);
  const packs = useLoad(() => api.rulePacks.list(), []);

  const [skill, setSkill] = useState<SkillView | null>(null);
  const [form, setForm] = useState<SkillForm | null>(id ? null : EMPTY);
  const [savedJson, setSavedJson] = useState(id ? '' : JSON.stringify(EMPTY));
  const [loadError, setLoadError] = useState<unknown>();
  const [saveError, setSaveError] = useState<unknown>();
  const [saving, setSaving] = useState(false);

  const [testInputs, setTestInputs] = useState<FormValues>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [fault, setFault] = useState<FaultType>('none');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SkillTestResult | null>(null);
  const [testError, setTestError] = useState<unknown>();
  const [tab, setTab] = useState<'output' | 'process' | 'prompt' | 'raw'>('output');
  /** Name for "保存为样例" (null = the inline form is closed). */
  const [caseName, setCaseName] = useState<string | null>(null);

  const load = (s: SkillView) => {
    setSkill(s);
    const f = toForm(s);
    setForm(f);
    setSavedJson(JSON.stringify(f));
  };
  useEffect(() => {
    if (!id) return;
    api.skills
      .get(id)
      .then((s) => {
        load(s);
        if (s.draft.testCases[0]) setTestInputs(s.draft.testCases[0].inputs);
      })
      .catch(setLoadError);
  }, [id]);

  const unsaved = !!form && JSON.stringify(form) !== savedJson;
  useUnsavedWarning(unsaved);
  const readOnly = !can('skill.edit') || skill?.status === 'in_review';
  const canTest = can('skill.edit') || can('skill.approve');
  const setCfg = (patch: Partial<SkillConfig>) => setForm((f) => (f ? { ...f, config: { ...f.config, ...patch } } : f));
  const set = (patch: Partial<SkillForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const inputTags = useMemo(() => form?.config.inputs.map((i) => `「${i.key}」输入`).join('、') ?? '', [form?.config.inputs]);

  if (loadError) return <ErrorNotice error={loadError} />;
  if (!form) return <Loading />;
  const cfg = form.config;

  async function save() {
    if (!form) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const s = id ? await api.skills.update(id, form) : await api.skills.create(form);
      load(s);
      toast(`已保存「${s.name}」草稿`);
      if (!id) nav(`/skills/${s.id}`, { replace: true });
    } catch (e) {
      setSaveError(e);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!id || !form) return;
    const miss = cfg.inputs.filter((d) => d.required && !d.defaultValue && (testInputs[d.key] === undefined || (typeof testInputs[d.key] === 'string' && !(testInputs[d.key] as string).trim()))).map((d) => d.key);
    setMissing(miss);
    setResult(null);
    setTestError(undefined);
    if (miss.length) {
      setTestError({ message: `请先填写必填的测试输入：${cfg.inputs.filter((d) => miss.includes(d.key)).map((d) => `「${d.label || d.key}」`).join('、')}。` });
      return;
    }
    setTesting(true);
    try {
      const r = await api.skills.test(id, { inputs: toApiInputs(testInputs), config: readOnly ? undefined : cfg, fault: fault === 'none' ? undefined : fault });
      setResult(r);
      setTab('output');
    } catch (e) {
      setTestError(e);
    } finally {
      setTesting(false);
    }
  }

  function saveTestCase() {
    const name = (caseName ?? '').trim().slice(0, 60);
    if (!name) return;
    const inputs = Object.fromEntries(Object.entries(testInputs).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    setCfg({ testCases: [...cfg.testCases, { id: `tc_${Date.now().toString(36)}`, name, inputs }] });
    setCaseName(null);
    toast('已加入样例（上传的文件不会保存在样例中），保存 Skill 后生效');
  }

  async function remove() {
    if (!id || !window.confirm('确定删除这个 Skill？')) return;
    try {
      await api.skills.remove(id);
      toast('已删除');
      nav('/skills');
    } catch (e) {
      setSaveError(e);
    }
  }

  async function duplicate() {
    if (!id) return;
    try {
      const s = await api.skills.duplicate(id);
      toast(`已复制为「${s.name}」`);
      nav(`/skills/${s.id}`);
    } catch (e) {
      setSaveError(e);
    }
  }

  const exec = result?.execution;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="skill-title">{form.name || (id ? '未命名 Skill' : '新建 Skill')}</h1>
          <div className="row wrap small">
            {skill ? <LifecycleBadge status={skill.status} version={skill.publishedVersion} dirty={skill.dirty} /> : <span className="badge warn">尚未保存</span>}
            {unsaved && (
              <span className="badge warn" data-testid="dirty">
                有未保存的修改
              </span>
            )}
            {skill && <span className="muted">草稿更新于 {fmtTime(skill.updatedAt)}</span>}
            {skill && skill.usedBy.length > 0 && (
              <span className="muted">
                被使用于：
                {skill.usedBy.map((w, i) => (
                  <span key={w.id}>
                    {i > 0 && '、'}
                    <Link to={`/workflows/${w.id}`}>{w.name}</Link>
                  </span>
                ))}
                （正式运行使用已发布版本；草稿修改需审核通过后才生效）
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          {id && (
            <a className="btn" href={api.skills.exportUrl(id)} title="导出为 Agent Skills 标准格式">
              导出 SKILL.md
            </a>
          )}
          {id && can('skill.edit') && <button onClick={duplicate}>复制</button>}
          {id && can('skill.delete') && (
            <button className="danger" onClick={remove} disabled={skill?.status === 'in_review'}>
              删除
            </button>
          )}
          {!readOnly && (
            <button className="primary" onClick={save} disabled={saving || (!unsaved && !!id)} data-testid="save-skill">
              {saving ? '保存中…' : '保存草稿'}
            </button>
          )}
        </div>
      </div>

      {saveError ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorNotice error={saveError} />
        </div>
      ) : null}
      {skill?.status === 'in_review' && (
        <div style={{ marginBottom: 16 }}>
          <Explain kind="warn">该 Skill 正在审核中，内容已锁定。可以继续测试；如需修改，请先在“审核与审批”中撤回申请。</Explain>
        </div>
      )}

      <div className="grid-editor">
        <fieldset className="stack plain" disabled={readOnly}>
          <section className="panel">
            <h2 className="section">基本信息</h2>
            <label className="field">
              <span className="lbl">
                名称<em>*</em>
              </span>
              <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} data-testid="skill-name" placeholder="例如：市场部补充材料请求" />
            </label>
            <label className="field">
              <span className="lbl">描述</span>
              <AutoTextarea minRows={2} maxRows={8} value={form.description} onChange={(e) => set({ description: e.target.value })} data-testid="skill-description" />
            </label>
            <div className="cols-2">
              <label className="field">
                <span className="lbl">分类</span>
                <input type="text" value={form.category ?? ''} onChange={(e) => set({ category: e.target.value || undefined })} placeholder="如：营销合规" />
              </label>
              <label className="field">
                <span className="lbl">适用法域</span>
                <input type="text" value={form.jurisdiction ?? ''} onChange={(e) => set({ jurisdiction: e.target.value || undefined })} placeholder="如：SG（仅作标注）" />
              </label>
            </div>
          </section>

          <section className="panel">
            <h2 className="section">
              任务说明<span style={{ color: 'var(--red)' }}>*</span>
            </h2>
            <p className="section-help">像给一位新同事布置任务一样写：要做什么、按什么标准、注意什么。可用 {inputTags || '「输入 key」'} 指代输入内容（运行时材料会被包在随机边界标签中，按数据而不是指令处理）。</p>
            <textarea className="doc" rows={12} value={cfg.instructions} onChange={(e) => setCfg({ instructions: e.target.value })} data-testid="skill-instructions" />
          </section>

          <section className="panel">
            <h2 className="section">规则包</h2>
            <p className="section-help">AI 只能依据关联的规则包和输入作答，并须引用规则编号。正式运行只使用已经法律审核批准的规则包版本；测试运行使用草稿并给出提示。</p>
            <RulePackPicker value={cfg.rulePackIds} onChange={(rulePackIds) => setCfg({ rulePackIds })} packs={packs.data ?? []} />
            <label className="field" style={{ marginTop: 14 }}>
              <span className="lbl">团队备注（可选）</span>
              <AutoTextarea className="code" minRows={3} maxRows={14} value={cfg.knowledge} onChange={(e) => setCfg({ knowledge: e.target.value })} data-testid="skill-knowledge" aria-describedby="skill-knowledge-help" />
              <div className="field-help" id="skill-knowledge-help">
                补充的工作习惯、写作要求等。权威规则请放进规则包，以便审核。
              </div>
            </label>
          </section>

          <section className="panel">
            <h2 className="section">输入</h2>
            <p className="section-help">“文档 / 材料”类型的输入支持上传 PDF、Word、图片（本地 OCR）或粘贴文字；AI 会看到带页码的内容，可按需翻页查阅，支持视觉的模型还会直接查看原图/原 PDF。</p>
            <InputFieldsEditor value={cfg.inputs} onChange={(inputs) => setCfg({ inputs })} testId="skill-inputs" />
          </section>

          <section className="panel">
            <h2 className="section">输出要求</h2>
            <p className="section-help">结构化字段可以被下游节点按字段引用，也能做自动核对与结论核验；Markdown 适合给人阅读的最终文书。</p>
            <div className="row" style={{ marginBottom: 12 }}>
              <label className="check">
                <input
                  type="radio"
                  name="fmt"
                  checked={cfg.output.format === 'json'}
                  onChange={() => setCfg({ output: { format: 'json', fields: cfg.output.fields.length ? cfg.output.fields : [{ key: 'result', label: '结果', type: 'string', required: true }] } })}
                  data-testid="format-json"
                />
                结构化字段（JSON）
              </label>
              <label className="check">
                <input type="radio" name="fmt" checked={cfg.output.format === 'markdown'} onChange={() => setCfg({ output: { format: 'markdown', fields: [] }, checks: [], verification: undefined })} data-testid="format-markdown" />
                Markdown 文本
              </label>
            </div>
            {cfg.output.format === 'json' && <OutputFieldsEditor value={cfg.output.fields} onChange={(fields) => setCfg({ output: { ...cfg.output, fields } })} testId="skill-output-fields" />}
          </section>

          {cfg.output.format === 'json' && (
            <section className="panel">
              <h2 className="section">AI 输出核对（引文与编号）</h2>
              <p className="section-help">自动检查 AI 给出的引文、规则编号是否真的出现在原文（含页码）或规则包中；找不到的会标红，提醒人工核对。图片 OCR 文本使用近似匹配。</p>
              <ChecksEditor value={cfg.checks} onChange={(checks) => setCfg({ checks })} fields={cfg.output.fields} inputs={cfg.inputs} />
            </section>
          )}

          {cfg.output.format === 'json' && (
            <section className="panel">
              <h2 className="section">结论核验（法律结论的第二道防线）</h2>
              <p className="section-help">
                对问题清单逐条检查：引用的规则是否存在、规则适用的渠道是否覆盖本物料、风险等级是否与规则默认等级明显不符、引文是否只是 OCR 近似匹配；并可让只读的核验代理逐条尝试证伪。存疑项标为“优先复核”，其余为“常规复核”——核验只决定复核顺序，所有发现都需要人工确认，用 AI 核查 AI 不能代替律师判断。
              </p>
              <VerificationEditor value={cfg.verification} onChange={(verification) => setCfg({ verification })} fields={cfg.output.fields} inputs={cfg.inputs} />
            </section>
          )}

          <section className="panel">
            <h2 className="section">AI 可用的工具</h2>
            <p className="section-help">AI 在执行时可以调用这些只读工具查阅材料和规则。组织策略可以把某个工具设为“需人工批准”或“禁止”。</p>
            <ToolsPicker value={cfg.tools} onChange={(tools) => setCfg({ tools })} tools={platform.data?.tools ?? []} />
          </section>

          <details className="adv panel">
            <summary>高级设置</summary>
            <div className="cols-2">
              <label className="field">
                <span className="lbl">最大轮次（模型 ↔ 工具往返）</span>
                <input type="number" min={1} max={20} value={cfg.maxTurns ?? ''} placeholder="默认 8" onChange={(e) => setCfg({ maxTurns: e.target.value ? Number(e.target.value) : undefined })} />
              </label>
              <label className="field">
                <span className="lbl">最大输出长度（token）</span>
                <input type="number" min={256} max={128000} value={cfg.maxTokens ?? ''} placeholder="默认使用全局设置" onChange={(e) => setCfg({ maxTokens: e.target.value ? Number(e.target.value) : undefined })} />
              </label>
            </div>
          </details>
        </fieldset>

        <div className="stack">
          {skill && (
            <PublishPanel
              type="skill"
              liveVersion={skill.publishedVersion}
              dirty={skill.dirty}
              pendingReview={skill.pendingReview}
              versions={skill.versions}
              canSubmit={can('skill.submit')}
              unsaved={unsaved}
              onSubmit={async (note) => {
                await api.skills.submit(skill.id, note);
                load(await api.skills.get(skill.id));
              }}
            />
          )}

          <section className="panel" data-testid="test-panel">
            <h2 className="section">样例测试</h2>
            {!id ? (
              <p className="section-help">保存草稿后即可测试。</p>
            ) : !canTest ? (
              <p className="section-help">当前角色不能测试 Skill。</p>
            ) : (
              <>
                <p className="section-help">测试当前编辑中的配置（无需先保存）；关联的规则包使用草稿内容。</p>
                <SamplePicker defs={cfg.inputs} values={testInputs} onChange={(v) => (setTestInputs(v), setMissing([]))} />
                {cfg.testCases.length > 0 && (
                  <div className="row wrap" style={{ margin: '8px 0 12px' }}>
                    <span className="small muted">已保存的样例：</span>
                    {cfg.testCases.map((tc) => (
                      <button
                        key={tc.id}
                        className="sm"
                        onClick={() => {
                          setTestInputs(tc.inputs);
                          setMissing([]);
                        }}
                      >
                        {tc.name}
                      </button>
                    ))}
                  </div>
                )}
                <InputsForm defs={cfg.inputs} values={testInputs} onChange={setTestInputs} invalid={missing} testIdPrefix="test-input" />
                <details className="adv">
                  <summary>故障注入（用于验证异常处理）</summary>
                  <select value={fault} onChange={(e) => setFault(e.target.value as FaultType)} data-testid="test-fault">
                    {FAULT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </details>
                <div className="row wrap" style={{ marginTop: 12 }}>
                  <button className="primary" onClick={runTest} disabled={testing} data-testid="run-test">
                    {testing ? '测试中…' : '运行测试'}
                  </button>
                  {!readOnly && caseName === null && (
                    <button onClick={() => setCaseName(`样例 ${cfg.testCases.length + 1}`)} title="把当前测试输入保存为样例" data-testid="save-case">
                      保存为样例
                    </button>
                  )}
                </div>
                {!readOnly && caseName !== null && (
                  <div className="inline-form" data-testid="case-form">
                    <label className="cell grow">
                      <span className="cell-lbl">样例名称</span>
                      <input
                        type="text"
                        autoFocus
                        maxLength={60}
                        value={caseName}
                        onChange={(e) => setCaseName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveTestCase();
                          if (e.key === 'Escape') setCaseName(null);
                        }}
                        data-testid="case-name"
                      />
                    </label>
                    <button className="primary" onClick={saveTestCase} disabled={!caseName.trim()} data-testid="case-add">
                      加入样例
                    </button>
                    <button className="ghost" onClick={() => setCaseName(null)}>
                      取消
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          {(testError || result) && (
            <section className="panel" data-testid="test-result">
              {testError ? <ErrorNotice error={testError} /> : null}
              {result && exec && (
                <>
                  <div className="summary-bar">
                    {exec.ok ? <span className="badge ok">测试成功</span> : <span className="badge bad">测试失败</span>}
                    <ModeBadge mode={result.provider.mode} />
                    <span className="small muted">{(exec.latencyMs / 1000).toFixed(1)} s</span>
                    <span className="small muted">{exec.turns} 轮</span>
                    {exec.attempts > 1 && <span className="small muted">调用 {exec.attempts} 次</span>}
                    {exec.usage?.inputTokens !== undefined && (
                      <span className="small muted">
                        token {exec.usage.inputTokens} / {exec.usage.outputTokens}
                      </span>
                    )}
                    {exec.validation?.repaired && <span className="badge warn">已自动修正输出</span>}
                    <GroundingSummary grounding={exec.validation?.grounding} />
                    <VerificationSummary v={exec.verification} />
                  </div>
                  {result.warnings.map((w) => (
                    <div key={w.code} className="notice warn small" style={{ marginBottom: 8 }}>
                      {w.message}
                    </div>
                  ))}
                  {!exec.ok && exec.error && <ErrorNotice error={exec.error} />}
                  <div className="tabs">
                    <button className={tab === 'output' ? 'on' : ''} onClick={() => setTab('output')}>
                      结果
                    </button>
                    <button className={tab === 'process' ? 'on' : ''} onClick={() => setTab('process')} data-testid="tab-process">
                      AI 过程
                    </button>
                    <button className={tab === 'prompt' ? 'on' : ''} onClick={() => setTab('prompt')}>
                      提示词
                    </button>
                    <button className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>
                      原始返回
                    </button>
                  </div>
                  {tab === 'output' && (
                    <>
                      <SecurityNotes s={exec.security} />
                      {exec.ok ? (
                        <OutputView value={exec.output} format={cfg.output.format} fields={cfg.output.fields} grounding={exec.validation?.grounding} verification={exec.verification} />
                      ) : (
                        <div className="muted small">本次测试没有可用结果。</div>
                      )}
                    </>
                  )}
                  {tab === 'process' && <Transcript entries={exec.transcript} />}
                  {tab === 'prompt' && (
                    <>
                      <div className="out-key">System（分层：平台 → 代理 → 组织 → Skill ┆ 动态上下文）</div>
                      <pre className="raw">{exec.prompt.system}</pre>
                      <div className="out-key">User</div>
                      <pre className="raw">{exec.prompt.user}</pre>
                    </>
                  )}
                  {tab === 'raw' && <pre className="raw">{exec.rawOutput ?? '（无）'}</pre>}
                </>
              )}
            </section>
          )}
        </div>
      </div>
      {skill && canTest && (
        <div style={{ marginTop: 16 }}>
          <EvalPanel skill={skill} unsaved={unsaved} onSkillChange={load} />
        </div>
      )}
    </>
  );
}
