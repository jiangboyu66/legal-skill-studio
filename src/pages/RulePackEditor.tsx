import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RulePackContent, RulePackView } from '../../shared/types';
import { api } from '../api';
import { RulesEditor } from '../components/editors';
import PublishPanel from '../components/PublishPanel';
import { AutoTextarea, ErrorNotice, Explain, fmtDate, LifecycleBadge, Loading, useAuth, useToast, useUnsavedWarning } from '../components/ui';

interface PackForm {
  name: string;
  jurisdiction: string;
  description: string;
  content: RulePackContent;
}
const EMPTY: PackForm = { name: '', jurisdiction: 'SG', description: '', content: { rules: [] } };
const toForm = (p: RulePackView): PackForm => ({ name: p.name, jurisdiction: p.jurisdiction, description: p.description, content: p.draft });

export default function RulePackEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [pack, setPack] = useState<RulePackView | null>(null);
  const [form, setForm] = useState<PackForm | null>(id ? null : EMPTY);
  const [savedJson, setSavedJson] = useState(id ? '' : JSON.stringify(EMPTY));
  const [loadError, setLoadError] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [saving, setSaving] = useState(false);

  const load = (p: RulePackView) => {
    setPack(p);
    const f = toForm(p);
    setForm(f);
    setSavedJson(JSON.stringify(f));
  };
  useEffect(() => {
    if (id) api.rulePacks.get(id).then(load).catch(setLoadError);
  }, [id]);
  const unsaved = !!form && JSON.stringify(form) !== savedJson;
  useUnsavedWarning(unsaved);
  if (loadError) return <ErrorNotice error={loadError} />;
  if (!form) return <Loading />;
  const readOnly = !can('rulepack.edit') || pack?.status === 'in_review';
  const set = (patch: Partial<PackForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(undefined);
    try {
      const p = id ? await api.rulePacks.update(id, form) : await api.rulePacks.create(form);
      load(p);
      toast('已保存规则包草稿');
      if (!id) nav(`/rulepacks/${p.id}`, { replace: true });
    } catch (e) {
      setError(e);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!id || !window.confirm('确定删除这个规则包？')) return;
    try {
      await api.rulePacks.remove(id);
      nav('/rulepacks');
    } catch (e) {
      setError(e);
    }
  }

  const unverified = form.content.rules.filter((r) => r.source.verification !== 'verbatim').length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="rulepack-title">{form.name || '新建规则包'}</h1>
          <div className="row wrap small">
            {pack ? <LifecycleBadge status={pack.status} version={pack.approvedVersion} dirty={pack.dirty} /> : <span className="badge warn">尚未保存</span>}
            {unsaved && <span className="badge warn">有未保存的修改</span>}
            {pack?.usedBy.length ? (
              <span className="muted">
                被 Skill 使用：
                {pack.usedBy.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && '、'}
                    <Link to={`/skills/${s.id}`}>{s.name}</Link>
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        </div>
        <div className="actions">
          {id && can('rulepack.edit') && (
            <button className="danger" onClick={remove} disabled={pack?.status === 'in_review'}>
              删除
            </button>
          )}
          {!readOnly && (
            <button className="primary" onClick={save} disabled={saving || (!unsaved && !!id)} data-testid="save-rulepack">
              {saving ? '保存中…' : '保存草稿'}
            </button>
          )}
        </div>
      </div>
      <ErrorNotice error={error} />

      {pack?.approval && (
        <div className="panel attest" data-testid="rulepack-approval">
          <h2 className="section">当前生效的审核声明（v{pack.approvedVersion}）</h2>
          <div className="kv">
            <div className="k">审核人</div>
            <div>
              {pack.approval.approverName}（{pack.approval.approverQualification}）
            </div>
            <div className="k">批准时间</div>
            <div>{fmtDate(pack.approval.approvedAt)}</div>
            <div className="k">复审截止</div>
            <div>
              {fmtDate(pack.approval.reviewDueAt)} {pack.status === 'expired' && <span className="badge bad">已过期：正式运行将被拦截</span>}
            </div>
            <div className="k">声明</div>
            <div>{pack.approval.attestation}</div>
            {pack.approval.comment && (
              <>
                <div className="k">审核意见</div>
                <div>{pack.approval.comment}</div>
              </>
            )}
          </div>
        </div>
      )}
      {pack && !pack.approval && (
        <div style={{ margin: '16px 0' }}>
          <Explain kind="warn">
            该规则包尚未经过法律审核，不能用于正式运行（组织策略可调整）。示例规则整理自公开资料，<strong>未经新加坡执业律师审核</strong>；请由具备资质的审核人逐条核对来源原文和适用范围后批准。
          </Explain>
        </div>
      )}

      <div className="grid-editor" style={{ marginTop: 16 }}>
        <fieldset className="stack plain" disabled={readOnly}>
          <section className="panel">
            <h2 className="section">基本信息</h2>
            <div className="cols-2">
              <label className="field">
                <span className="lbl">
                  名称<em>*</em>
                </span>
                <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} data-testid="rulepack-name" />
              </label>
              <label className="field">
                <span className="lbl">法域</span>
                <input type="text" value={form.jurisdiction} onChange={(e) => set({ jurisdiction: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="lbl">说明</span>
              <textarea rows={2} value={form.description} onChange={(e) => set({ description: e.target.value })} />
            </label>
            <label className="field">
              <span className="lbl">给 AI 的补充说明</span>
              <AutoTextarea minRows={2} maxRows={10} value={form.content.notes ?? ''} onChange={(e) => set({ content: { ...form.content, notes: e.target.value || undefined } })} aria-describedby="pack-notes-help" />
              <div className="field-help" id="pack-notes-help">
                例如：规则为摘要，不是法规原文；未覆盖的问题请使用编号 N/A。
              </div>
            </label>
          </section>
          <section className="panel">
            <h2 className="section">规则（{form.content.rules.length}）</h2>
            <p className="section-help">
              每条规则需注明来源和核实程度。“原文已核对”需要附来源原文摘录；“转述”与“未核实”的规则会在审核页高亮，审核人应逐条核对。{unverified > 0 && `当前有 ${unverified} 条规则未附原文核对。`}
            </p>
            <RulesEditor value={form.content.rules} onChange={(rules) => set({ content: { ...form.content, rules } })} readOnly={readOnly} />
          </section>
        </fieldset>
        <div className="stack">
          {pack && (
            <PublishPanel
              type="rulepack"
              liveVersion={pack.approvedVersion}
              dirty={pack.dirty}
              pendingReview={pack.pendingReview}
              approvals={pack.history}
              canSubmit={can('rulepack.submit')}
              unsaved={unsaved}
              blocked={pack.draft.rules.length ? undefined : '至少需要一条规则。'}
              onSubmit={async (note) => {
                await api.rulePacks.submit(pack.id, note);
                load(await api.rulePacks.get(pack.id));
              }}
            />
          )}
          {pack && (
            <div className="panel small">
              <h2 className="section">来源核实情况</h2>
              <div className="kv">
                <div className="k">原文已核对</div>
                <div>{pack.stats.verbatim}</div>
                <div className="k">转述</div>
                <div>{pack.stats.paraphrased}</div>
                <div className="k">未核实</div>
                <div>{pack.stats.unverified}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
