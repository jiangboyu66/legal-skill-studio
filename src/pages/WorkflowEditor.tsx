import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listOutputPaths, ROLE_LABEL } from '../../shared/schema';
import type { ApprovalNode, Mapping, Role, SkillConfig, SkillNode, SkillView, ValidationIssue, WorkflowDef, WorkflowNode, WorkflowView } from '../../shared/types';
import { api } from '../api';
import DagGraph from '../components/DagGraph';
import { InputFieldsEditor } from '../components/editors';
import { WorkflowOverview } from '../components/Overview';
import PublishPanel from '../components/PublishPanel';
import { AutoTextarea, ErrorNotice, Explain, IssuesList, LifecycleBadge, Loading, useAuth, useLoad, useToast, useUnsavedWarning } from '../components/ui';

interface WfForm {
  name: string;
  description: string;
  def: WorkflowDef;
}
const EMPTY: WfForm = { name: '', description: '', def: { inputs: [{ key: 'material', label: '营销物料', type: 'document', required: true }], nodes: [] } };
const toForm = (w: WorkflowView): WfForm => ({ name: w.name, description: w.description, def: w.draft });

function ancestorsOf(nodes: WorkflowNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const stack = [...(byId.get(id)?.needs ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (out.has(x) || x === id) continue;
    out.add(x);
    stack.push(...(byId.get(x)?.needs ?? []));
  }
  return out;
}

const encode = (m?: Mapping): string =>
  !m ? '' : m.type === 'workflow_input' ? `wi:${m.key}` : m.type === 'literal' ? 'lit' : m.type === 'node_output' ? (m.path ? `nf:${m.nodeId}:${m.path}` : `no:${m.nodeId}`) : encode(m.options[0]);

function decode(v: string, prev?: Mapping): Mapping | undefined {
  if (!v) return undefined;
  if (v === 'lit') return { type: 'literal', value: prev?.type === 'literal' ? prev.value : '' };
  const [kind, a, ...rest] = v.split(':');
  if (kind === 'wi') return { type: 'workflow_input', key: a };
  if (kind === 'no') return { type: 'node_output', nodeId: a };
  if (kind === 'nf') return { type: 'node_output', nodeId: a, path: rest.join(':') };
  return undefined;
}

/** Suggests sources for a new skill node: same-named workflow inputs, upstream fields, else the latest upstream output. */
function autoMap(cfg: SkillConfig, needs: string[], def: WorkflowDef, skills: Map<string, SkillView>): Record<string, Mapping> {
  const m: Record<string, Mapping> = {};
  const upstream = def.nodes.filter((n) => needs.includes(n.id) && n.type === 'skill') as SkillNode[];
  let usedWhole = false;
  for (const inp of cfg.inputs) {
    if (def.inputs.some((w) => w.key === inp.key)) {
      m[inp.key] = { type: 'workflow_input', key: inp.key };
      continue;
    }
    const src = upstream.find((p) => skills.get(p.skillId)?.draft.output.fields.some((f) => f.key === inp.key));
    if (src) {
      m[inp.key] = { type: 'node_output', nodeId: src.id, path: inp.key };
      continue;
    }
    if (!usedWhole && upstream.length && inp.required) {
      m[inp.key] = { type: 'node_output', nodeId: upstream[upstream.length - 1].id };
      usedWhole = true;
    }
  }
  return m;
}

function renameRefs(def: WorkflowDef, from: string, to: string): WorkflowDef {
  const mapM = (m: Mapping): Mapping => (m.type === 'node_output' && m.nodeId === from ? { ...m, nodeId: to } : m.type === 'coalesce' ? { ...m, options: m.options.map(mapM) } : m);
  const re = new RegExp(`\\bnodes\\.${from}\\b`, 'g');
  return {
    ...def,
    outputNodeId: def.outputNodeId === from ? to : def.outputNodeId,
    nodes: def.nodes.map((n) => {
      const base = { ...n, id: n.id === from ? to : n.id, needs: n.needs.map((x) => (x === from ? to : x)), when: n.when?.replace(re, `nodes.${to}`) };
      return n.type === 'skill'
        ? ({ ...base, mappings: Object.fromEntries(Object.entries(n.mappings).map(([k, m]) => [k, mapM(m)])) } as SkillNode)
        : ({ ...base, showNodeIds: n.showNodeIds.map((x) => (x === from ? to : x)) } as ApprovalNode);
    }),
  };
}

/** 使用者 (no edit / approve right) get a read-only overview of the published workflow instead of the editor. */
export default function WorkflowEditor() {
  const { id } = useParams();
  const { can } = useAuth();
  if (id && !can('workflow.edit') && !can('workflow.approve')) return <WorkflowOverview id={id} />;
  return <WorkflowEditorPage />;
}

function WorkflowEditorPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const skillsQ = useLoad(() => api.skills.list(), []);
  const [wf, setWf] = useState<WorkflowView | null>(null);
  const [form, setForm] = useState<WfForm | null>(id ? null : structuredClone(EMPTY));
  const [savedJson, setSavedJson] = useState(id ? '' : JSON.stringify(EMPTY));
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [loadError, setLoadError] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  const [addSkillId, setAddSkillId] = useState('');
  const [selected, setSelected] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const load = (w: WorkflowView) => {
    setWf(w);
    const f = toForm(w);
    setForm(f);
    setSavedJson(JSON.stringify(f));
    setIssues(w.issues);
  };
  useEffect(() => {
    if (id) api.workflows.get(id).then(load).catch(setLoadError);
  }, [id]);
  useEffect(() => {
    if (!form) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.workflows
        .validate(form.def)
        .then((r) => setIssues(r.issues))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(timer.current);
  }, [form?.def]); // eslint-disable-line react-hooks/exhaustive-deps

  const skills = useMemo(() => new Map((skillsQ.data ?? []).map((s) => [s.id, s])), [skillsQ.data]);
  const unsaved = !!form && JSON.stringify(form) !== savedJson;
  useUnsavedWarning(unsaved);
  if (loadError) return <ErrorNotice error={loadError} />;
  if (!form) return <Loading />;
  const def = form.def;
  const readOnly = !can('workflow.edit') || wf?.status === 'in_review';
  const setDef = (patch: Partial<WorkflowDef>) => setForm((f) => (f ? { ...f, def: { ...f.def, ...patch } } : f));
  const setNode = (nid: string, patch: Partial<SkillNode> | Partial<ApprovalNode>) => setDef({ nodes: def.nodes.map((n) => (n.id === nid ? ({ ...n, ...patch } as WorkflowNode) : n)) });
  const errorsCount = issues.filter((i) => i.level === 'error').length;

  function newId(base: string) {
    let n = def.nodes.length + 1;
    while (def.nodes.some((x) => x.id === `${base}_${n}`)) n++;
    return `${base}_${n}`;
  }
  function addSkillNode() {
    const s = skills.get(addSkillId);
    if (!s) return;
    const nid = newId('node');
    const needs = def.nodes.length ? [def.nodes[def.nodes.length - 1].id] : [];
    const node: SkillNode = { id: nid, name: s.name, type: 'skill', skillId: s.id, needs, mappings: autoMap(s.draft, needs, def, skills) };
    setDef({ nodes: [...def.nodes, node], outputNodeId: def.outputNodeId });
    setSelected(nid);
    setAddSkillId('');
  }
  function addApprovalNode() {
    const nid = newId('approval');
    const needs = def.nodes.length ? [def.nodes[def.nodes.length - 1].id] : [];
    const node: ApprovalNode = { id: nid, name: '人工审批', type: 'approval', needs, instructions: '请核对上游结果后决定是否继续。', showNodeIds: needs, approverRole: 'reviewer', onReject: 'stop' };
    setDef({ nodes: [...def.nodes, node] });
    setSelected(nid);
  }
  function removeNode(nid: string) {
    setDef({
      nodes: def.nodes.filter((n) => n.id !== nid).map((n) => ({ ...n, needs: n.needs.filter((x) => x !== nid), ...(n.type === 'approval' ? { showNodeIds: n.showNodeIds.filter((x) => x !== nid) } : {}) })),
      outputNodeId: def.outputNodeId === nid ? undefined : def.outputNodeId,
    });
  }
  function rename(from: string, to: string) {
    const clean = to.trim();
    if (!clean || clean === from) return;
    if (def.nodes.some((n) => n.id === clean)) {
      toast(`标识「${clean}」已被使用`, 'error');
      return;
    }
    setForm((f) => (f ? { ...f, def: renameRefs(f.def, from, clean) } : f));
    setSelected(clean);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(undefined);
    try {
      const w = id ? await api.workflows.update(id, form) : await api.workflows.create(form);
      load(w);
      toast('已保存工作流草稿');
      if (!id) nav(`/workflows/${w.id}`, { replace: true });
    } catch (e) {
      setError(e);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!id || !window.confirm('确定删除这个工作流？已有运行记录会保留。')) return;
    try {
      await api.workflows.remove(id);
      nav('/workflows');
    } catch (e) {
      setError(e);
    }
  }
  async function duplicate() {
    if (!id) return;
    try {
      const w = await api.workflows.duplicate(id);
      toast(`已复制为「${w.name}」`);
      nav(`/workflows/${w.id}`);
    } catch (e) {
      setError(e);
    }
  }

  const info = Object.fromEntries(
    def.nodes.map((n) => [n.id, { sub: n.type === 'skill' ? skills.get(n.skillId)?.name ?? '（Skill 不存在）' : `人工审批 · ${ROLE_LABEL[n.approverRole]}` }]),
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1 data-testid="workflow-title">{form.name || (id ? '未命名工作流' : '新建工作流')}</h1>
          <div className="row wrap small">
            {wf ? <LifecycleBadge status={wf.status} version={wf.publishedVersion} dirty={wf.dirty} /> : <span className="badge warn">尚未保存</span>}
            {unsaved && (
              <span className="badge warn" data-testid="dirty">
                有未保存的修改
              </span>
            )}
            {errorsCount > 0 && <span className="badge bad">{errorsCount} 处配置错误</span>}
          </div>
        </div>
        <div className="actions">
          {id && (wf?.publishedVersion ? can('workflow.run') : can('workflow.test')) && (
            <Link className="btn" to={`/workflows/${id}/run`} data-testid="goto-run">
              运行
            </Link>
          )}
          {id && can('workflow.edit') && <button onClick={duplicate}>复制</button>}
          {id && can('workflow.delete') && (
            <button className="danger" onClick={remove} disabled={wf?.status === 'in_review'}>
              删除
            </button>
          )}
          {!readOnly && (
            <button className="primary" onClick={save} disabled={saving || (!unsaved && !!id)} data-testid="save-workflow">
              {saving ? '保存中…' : '保存草稿'}
            </button>
          )}
        </div>
      </div>
      <ErrorNotice error={error} />
      {wf?.status === 'in_review' && <Explain kind="warn">该工作流正在审核中，内容已锁定。如需修改，请先撤回发布申请。</Explain>}

      <section className="panel" style={{ marginTop: 12 }}>
        <h2 className="section">流程图</h2>
        <p className="section-help">从左到右按依赖排列；同一列的节点可以并行运行；虚线箭头表示带“运行条件”的分支；圆角双框是人工审批节点。点击节点可编辑。</p>
        <DagGraph nodes={def.nodes} info={info} selected={selected} onSelect={(n) => (setSelected(n), document.getElementById(`node-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))} />
      </section>

      <div className="grid-wf" style={{ marginTop: 16 }}>
        <fieldset className="stack plain" disabled={readOnly}>
          <div className="panel">
            <h2 className="section">基本信息</h2>
            <label className="field">
              <span className="lbl">
                名称<em>*</em>
              </span>
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="workflow-name" />
            </label>
            <label className="field">
              <span className="lbl">描述</span>
              <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <label className="field">
              <span className="lbl">最终输出节点</span>
              <select value={def.outputNodeId ?? ''} onChange={(e) => setDef({ outputNodeId: e.target.value || undefined })} data-testid="output-node">
                <option value="">（最后一个成功的 AI 节点）</option>
                {def.nodes
                  .filter((n) => n.type === 'skill')
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="panel">
            <h2 className="section">工作流输入</h2>
            <p className="section-help">运行时由使用者提供；“文档 / 材料”支持上传 PDF、Word、图片。</p>
            <InputFieldsEditor value={def.inputs} onChange={(inputs) => setDef({ inputs })} testId="workflow-inputs" />
          </div>
          <Explain>
            运行条件写法：留空表示总是运行；条件不满足时节点被跳过，下游照常进行。可用 <code>== != &gt; &lt; &amp;&amp; || !</code>、<code>len()</code>、<code>count(列表, "字段", "值")</code>、<code>any()</code>、<code>contains()</code>；只能引用上游节点（<code>nodes.标识.output.字段</code>，审批节点用 <code>nodes.标识.decision</code>）或 <code>inputs.标识</code>。
          </Explain>
          {def.nodes.map((n) => {
            const up = ancestorsOf(def.nodes, n.id);
            const upNodes = def.nodes.filter((x) => up.has(x.id));
            const candidates = def.nodes.filter((x) => x.id !== n.id && !ancestorsOf(def.nodes, x.id).has(n.id));
            const nodeIssues = issues.filter((i) => i.nodeId === n.id);
            return (
              <div className={`step ${selected === n.id ? 'sel' : ''}`} key={n.id} id={`node-${n.id}`} data-testid={`node-${n.id}`}>
                <div className="step-head">
                  <span className={`step-kind k-${n.type}`}>{n.type === 'approval' ? '审批' : 'AI'}</span>
                  <input type="text" aria-label="节点名称" className="grow" value={n.name} onChange={(e) => setNode(n.id, { name: e.target.value })} />
                  <input type="text" aria-label="节点标识" className="mono" style={{ width: 130 }} defaultValue={n.id} key={n.id} onBlur={(e) => rename(n.id, e.target.value)} title="节点标识（用于条件表达式和连线；修改后自动更新引用）" />
                  <button type="button" className="ghost sm danger" onClick={() => removeNode(n.id)} aria-label={`删除节点 ${n.name}`}>
                    ✕
                  </button>
                </div>
                <div className="step-body">
                  <div className="map">
                    <div className="k">依赖（上游）</div>
                    <div className="row wrap">
                      {candidates.length === 0 && <span className="muted small">（没有可选的上游节点）</span>}
                      {candidates.map((x) => (
                          <label key={x.id} className="check">
                            <input type="checkbox" checked={n.needs.includes(x.id)} onChange={(e) => setNode(n.id, { needs: e.target.checked ? [...n.needs, x.id] : n.needs.filter((d) => d !== x.id) })} data-testid={`needs-${n.id}-${x.id}`} />
                            {x.name}
                          </label>
                        ))}
                    </div>
                    <div className="k">
                      运行条件<small>可选</small>
                    </div>
                    <div>
                      <input
                        type="text"
                        className="mono"
                        spellCheck={false}
                        value={n.when ?? ''}
                        placeholder="留空 = 总是运行"
                        aria-label={`${n.name} 的运行条件`}
                        title={n.when}
                        onChange={(e) => setNode(n.id, { when: e.target.value || undefined })}
                        data-testid={`when-${n.id}`}
                      />
                      {!n.when && (
                        <div className="field-help">
                          例：<code>nodes.check.output.overall_risk == "high"</code>
                        </div>
                      )}

                    </div>
                  </div>
                  {n.type === 'skill' ? (
                    <SkillNodeBody node={n} def={def} skills={skills} upNodes={upNodes} onChange={(patch) => setNode(n.id, patch)} pinned={wf?.published?.pins?.[n.skillId]} />
                  ) : (
                    <ApprovalNodeBody node={n} upNodes={upNodes} onChange={(patch) => setNode(n.id, patch)} />
                  )}
                  {nodeIssues.length > 0 && (
                    <ul className="node-issues">
                      {nodeIssues.map((i, k) => (
                        <li key={k} className={i.level}>
                          {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
          {!readOnly && (
            <div className="panel add-node">
              <div className="row wrap">
                <select value={addSkillId} onChange={(e) => setAddSkillId(e.target.value)} aria-label="选择要添加的 Skill" data-testid="add-skill-select" style={{ maxWidth: 360 }}>
                  <option value="">选择 Skill…</option>
                  {(skillsQ.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.publishedVersion ? `（v${s.publishedVersion}）` : '（未发布）'}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={addSkillNode} disabled={!addSkillId} data-testid="add-skill-node">
                  ＋ 添加 AI 节点
                </button>
                <button type="button" onClick={addApprovalNode} data-testid="add-approval-node">
                  ＋ 添加人工审批节点
                </button>
              </div>
              <div className="field-help">新节点默认依赖最后一个节点；可在“依赖”中改为并行或汇合。</div>
            </div>
          )}
        </fieldset>

        <div className="stack">
          <div className="panel">
            <h2 className="section">配置检查</h2>
            <IssuesList issues={issues} />
          </div>
          {wf && (
            <PublishPanel
              type="workflow"
              liveVersion={wf.publishedVersion}
              dirty={wf.dirty}
              pendingReview={wf.pendingReview}
              versions={wf.versions}
              canSubmit={can('workflow.submit')}
              unsaved={unsaved}
              blocked={errorsCount ? '请先修正配置错误。' : undefined}
              upgrade={
                wf.published && wf.pinInfo.some((p) => p.latest && (!p.pinned || p.latest > p.pinned))
                  ? `有 Skill 发布了新版本（见下表），线上工作流仍使用钉住的旧版本；重新提交审批即可升级。`
                  : undefined
              }
              onSubmit={async (note) => {
                await api.workflows.submit(wf.id, note);
                load(await api.workflows.get(wf.id));
              }}
            />
          )}
          {wf?.published && wf.pinInfo.length > 0 && (
            <section className="panel" data-testid="pin-panel">
              <h2 className="section">钉住的 Skill 版本</h2>
              <p className="section-help">正式运行只使用审批时钉住的 Skill 版本。Skill 发布新版本后，需要重新提交本工作流审批才会升级，审核人能看到版本变化。</p>
              <table className="t pin-table">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>钉住</th>
                    <th>最新发布</th>
                  </tr>
                </thead>
                <tbody>
                  {wf.pinInfo.map((p) => (
                    <tr key={p.skillId}>
                      <td>
                        <Link to={`/skills/${p.skillId}`}>{p.skillName}</Link>
                      </td>
                      <td>{p.pinned ? `v${p.pinned}` : <span className="badge warn">未钉住</span>}</td>
                      <td>
                        {p.latest ? `v${p.latest}` : '—'}
                        {p.latest && p.pinned && p.latest > p.pinned && <span className="badge warn" style={{ marginLeft: 6 }}>可升级</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function SkillNodeBody({ node, def, skills, upNodes, onChange, pinned }: { node: SkillNode; def: WorkflowDef; skills: Map<string, SkillView>; upNodes: WorkflowNode[]; onChange: (p: Partial<SkillNode>) => void; pinned?: number }) {
  const s = skills.get(node.skillId);
  const cfg = s?.draft;
  return (
    <div className="map" style={{ marginTop: 10 }}>
      <div className="k">Skill</div>
      <div className="row wrap">
        <select
          value={node.skillId}
          onChange={(e) => {
            const ns = skills.get(e.target.value);
            onChange({ skillId: e.target.value, mappings: ns ? autoMap(ns.draft, node.needs, def, skills) : {} });
          }}
          aria-label="Skill"
          style={{ maxWidth: 320 }}
        >
          {!s && <option value={node.skillId}>（Skill 不存在）</option>}
          {[...skills.values()].map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        {s && <LifecycleBadge status={s.status} version={s.publishedVersion} dirty={s.dirty} />}
        {s && pinned && pinned !== s.publishedVersion && (
          <span className="badge warn" title="正式运行使用审批时钉住的版本；重新提交工作流审批后升级">
            线上工作流钉住 v{pinned}
          </span>
        )}
        {s && (
          <Link to={`/skills/${s.id}`} className="small">
            查看 Skill
          </Link>
        )}
      </div>
      {cfg?.inputs.map((inp) => {
        const m = node.mappings[inp.key];
        const primary = m?.type === 'coalesce' ? m.options[0] : m;
        const fallback = m?.type === 'coalesce' ? m.options.find((o) => o.type === 'literal') : undefined;
        const setMapping = (p?: Mapping, fb?: string) => {
          const next = { ...node.mappings };
          if (!p) delete next[inp.key];
          else next[inp.key] = fb !== undefined ? { type: 'coalesce', options: [p, { type: 'literal', value: fb }] } : p;
          onChange({ mappings: next });
        };
        return (
          <div key={inp.key} style={{ display: 'contents' }}>
            <div className="k">
              {inp.label || inp.key}
              {inp.required && <span style={{ color: 'var(--red)' }}>*</span>}
              <small>{inp.key}</small>
            </div>
            <div>
              <select
                value={encode(primary)}
                onChange={(e) => setMapping(decode(e.target.value, primary), fallback ? (fallback as { value: string }).value : undefined)}
                aria-label={`${inp.label} 的来源`}
                data-testid={`map-${node.id}-${inp.key}`}
              >
                <option value="">（不提供{inp.defaultValue ? `，使用默认值` : ''}）</option>
                <optgroup label="工作流输入">
                  {def.inputs.map((w) => (
                    <option key={w.key} value={`wi:${w.key}`}>
                      工作流输入「{w.label || w.key}」
                    </option>
                  ))}
                </optgroup>
                {upNodes
                  .filter((u) => u.type === 'skill' || u.type === 'approval')
                  .map((u) => {
                    const us = u.type === 'skill' ? skills.get(u.skillId) : undefined;
                    return (
                      <optgroup key={u.id} label={`上游「${u.name}」`}>
                        <option value={`no:${u.id}`}>{u.type === 'approval' ? '审批结果（决定与意见）' : '完整输出'}</option>
                        {us?.draft.output.format === 'json' &&
                          listOutputPaths(us.draft.output.fields)
                            .filter((p) => !p.path.includes('[]'))
                            .map((p) => (
                              <option key={p.path} value={`nf:${u.id}:${p.path}`}>
                                字段「{p.label}」
                              </option>
                            ))}
                      </optgroup>
                    );
                  })}
                <option value="lit">固定文本</option>
              </select>
              {primary?.type === 'literal' && (
                <AutoTextarea minRows={2} maxRows={8} style={{ marginTop: 6 }} aria-label="固定文本内容" value={primary.value} onChange={(e) => setMapping({ type: 'literal', value: e.target.value })} placeholder="固定文本内容" />
              )}
              {primary?.type === 'node_output' && (
                <label className="check small" style={{ marginTop: 6 }}>
                  <input type="checkbox" checked={!!fallback} onChange={(e) => setMapping(primary, e.target.checked ? '（上游节点未运行）' : undefined)} />
                  上游被跳过时改用固定文本
                </label>
              )}
              {primary?.type === 'node_output' && fallback && (
                <input type="text" aria-label="上游被跳过时使用的文本" value={(fallback as { value: string }).value} onChange={(e) => setMapping(primary, e.target.value)} style={{ marginTop: 6 }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const ROLES: Role[] = ['reviewer', 'admin', 'builder', 'runner'];

function ApprovalNodeBody({ node, upNodes, onChange }: { node: ApprovalNode; upNodes: WorkflowNode[]; onChange: (p: Partial<ApprovalNode>) => void }) {
  return (
    <div className="map" style={{ marginTop: 10 }}>
      <div className="k">审批说明</div>
      <textarea rows={3} value={node.instructions} onChange={(e) => onChange({ instructions: e.target.value })} aria-label="审批说明" />
      <div className="k">审批角色</div>
      <select value={node.approverRole} onChange={(e) => onChange({ approverRole: e.target.value as Role })} aria-label="审批角色" style={{ maxWidth: 260 }}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <div className="k">驳回后</div>
      <select value={node.onReject} onChange={(e) => onChange({ onReject: e.target.value as ApprovalNode['onReject'] })} aria-label="驳回后" style={{ maxWidth: 360 }}>
        <option value="stop">终止运行（状态为“已驳回”）</option>
        <option value="continue">继续运行（下游可用条件读取 decision）</option>
      </select>
      <div className="k">向审批人展示</div>
      <div className="row wrap">
        {upNodes.length === 0 && <span className="muted small">（请先设置依赖）</span>}
        {upNodes.map((u) => (
          <label key={u.id} className="check">
            <input type="checkbox" checked={node.showNodeIds.includes(u.id)} onChange={(e) => onChange({ showNodeIds: e.target.checked ? [...node.showNodeIds, u.id] : node.showNodeIds.filter((x) => x !== u.id) })} />
            {u.name}
          </label>
        ))}
      </div>
    </div>
  );
}
