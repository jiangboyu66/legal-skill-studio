import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { FaultType } from '../../shared/types';
import { api } from '../api';
import DagGraph from '../components/DagGraph';
import { type FormValues, InputsForm, SamplePicker, toApiInputs } from '../components/inputs';
import { ErrorNotice, Explain, LifecycleBadge, Loading, useAuth, useLoad } from '../components/ui';
import { FAULT_OPTIONS } from './SkillEditor';

export default function RunStart() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const wfQ = useLoad(() => api.workflows.get(id!), [id]);
  const skillsQ = useLoad(() => api.skills.list(), []);
  const packsQ = useLoad(() => api.rulePacks.list(), []);
  const [mode, setMode] = useState<'production' | 'test'>('production');
  const [values, setValues] = useState<FormValues>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [fault, setFault] = useState<FaultType>('none');
  const [faultNode, setFaultNode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const wf = wfQ.data;
  useEffect(() => {
    if (wf && !wf.publishedVersion) setMode('test');
  }, [wf]);
  if (wfQ.error) return <ErrorNotice error={wfQ.error} />;
  if (!wf) return <Loading />;

  const canProd = !!wf.publishedVersion && can('workflow.run');
  const canTest = can('workflow.test');
  const def = mode === 'production' ? wf.published ?? wf.draft : wf.draft;
  const skillIds = new Set(def.nodes.flatMap((n) => (n.type === 'skill' ? [n.skillId] : [])));
  const packIds = new Set((skillsQ.data ?? []).filter((s) => skillIds.has(s.id)).flatMap((s) => (mode === 'production' ? s.published ?? s.draft : s.draft).rulePackIds));
  const packs = (packsQ.data ?? []).filter((p) => packIds.has(p.id));
  const unapproved = packs.filter((p) => !p.approvedVersion || p.status === 'expired');
  const policyBlocks = mode === 'production' && unapproved.length > 0;

  async function start() {
    const miss = def.inputs.filter((d) => d.required && !d.defaultValue && (values[d.key] === undefined || (typeof values[d.key] === 'string' && !(values[d.key] as string).trim()))).map((d) => d.key);
    setMissing(miss);
    if (miss.length) {
      setError({ message: `请填写必填输入：${def.inputs.filter((d) => miss.includes(d.key)).map((d) => `「${d.label || d.key}」`).join('、')}。` });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const run = await api.workflows.run(wf!.id, { mode, inputs: toApiInputs(values), fault: mode === 'test' && fault !== 'none' ? { type: fault, nodeId: faultNode || undefined } : undefined });
      nav(`/runs/${run.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>运行：{wf.name}</h1>
          <div className="row wrap small">
            <LifecycleBadge status={wf.status} version={wf.publishedVersion} dirty={wf.dirty} />
            <Link to={`/workflows/${wf.id}`}>查看工作流</Link>
          </div>
        </div>
      </div>
      <section className="panel" style={{ marginBottom: 16 }}>
          <h2 className="section">将执行的流程</h2>
          <DagGraph nodes={def.nodes} testId="run-start-dag" />
          <p className="section-help" style={{ marginTop: 10 }}>
            运行开始后可以离开本页面：进度实时保存，需要审批的节点会出现在审核人的“审核与审批”中。
          </p>
      </section>
      <div className="run-start">
        <div className="stack">
          <section className="panel">
            <h2 className="section">运行方式</h2>
            {canTest ? (
              <div className="row wrap" role="radiogroup" aria-label="运行方式">
                <label className="check">
                  <input type="radio" name="mode" checked={mode === 'production'} disabled={!canProd} onChange={() => setMode('production')} data-testid="mode-production" />
                  正式运行（已发布 v{wf.publishedVersion ?? '-'}，使用已批准的规则包）
                </label>
                <label className="check">
                  <input type="radio" name="mode" checked={mode === 'test'} disabled={!canTest} onChange={() => setMode('test')} data-testid="mode-test" />
                  测试运行（草稿配置，结果仅供调试）
                </label>
              </div>
            ) : (
              <p className="small" style={{ margin: 0 }} data-testid="mode-fixed">
                正式运行：使用已发布的 v{wf.publishedVersion ?? '-'}，规则包使用经法律审核批准的版本。
              </p>
            )}
            {!wf.publishedVersion && <div className="field-help">该工作流尚未发布，只能由创建者测试运行。</div>}
            {packs.length > 0 && (
              <div className="pack-status small" style={{ marginTop: 10 }}>
                使用的规则包：
                {packs.map((p) => (
                  <span key={p.id} style={{ marginRight: 10 }}>
                    {p.name} <LifecycleBadge status={p.status} version={p.approvedVersion} />
                  </span>
                ))}
              </div>
            )}
            {policyBlocks && (
              <div style={{ marginTop: 10 }}>
                <Explain kind="warn">
                  规则包「{unapproved.map((p) => p.name).join('、')}」尚未经法律审核批准或审核已过期。按组织策略，正式运行会被拦截；请先由审核人在“审核与审批”中完成规则包审核。
                </Explain>
              </div>
            )}
          </section>
          <section className="panel">
            <h2 className="section">输入</h2>
            <SamplePicker defs={def.inputs} values={values} onChange={(v) => (setValues(v), setMissing([]))} />
            <div style={{ marginTop: 12 }}>
              <InputsForm defs={def.inputs} values={values} onChange={setValues} invalid={missing} testIdPrefix="run-input" />
            </div>
            {mode === 'test' && (
              <details className="adv">
                <summary>故障注入（仅测试运行；用于验证异常处理）</summary>
                <div className="row wrap">
                  <select value={fault} onChange={(e) => setFault(e.target.value as FaultType)} data-testid="run-fault" style={{ maxWidth: 300 }}>
                    {FAULT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <select value={faultNode} onChange={(e) => setFaultNode(e.target.value)} data-testid="run-fault-node" style={{ maxWidth: 260 }}>
                    <option value="">注入到节点…</option>
                    {def.nodes
                      .filter((n) => n.type === 'skill')
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                  </select>
                </div>
              </details>
            )}
            <ErrorNotice error={error} />
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" onClick={start} disabled={busy || (mode === 'production' ? !canProd : !canTest)} data-testid="start-run">
                {busy ? '正在启动…' : mode === 'production' ? '开始运行' : '开始测试运行'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
