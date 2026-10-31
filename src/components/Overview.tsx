import { Link } from 'react-router-dom';
import { ROLE_LABEL } from '../../shared/schema';
import type { InputField, OutputField } from '../../shared/types';
import { api } from '../api';
import DagGraph from './DagGraph';
import { ErrorNotice, LifecycleBadge, Loading, useAuth, useLoad } from './ui';

/**
 * Read-only pages for 使用者 (no edit / approve right): what a published Skill or workflow does, what it
 * needs and what it returns. No authoring sections, tests, evaluation or publishing controls; the server
 * only sends published content to these users in the first place.
 */

export const INPUT_TYPE_LABEL: Record<InputField['type'], string> = { document: '文档 / 材料', long_text: '多行文本', text: '单行文本' };
const FIELD_TYPE_LABEL: Record<OutputField['type'], string> = { string: '文本', number: '数字', boolean: '是 / 否', enum: '固定选项', string_list: '文本列表', object_list: '表格（多项）' };

export function InputSummary({ inputs }: { inputs: InputField[] }) {
  if (!inputs.length) return <p className="muted small">不需要输入。</p>;
  return (
    <div className="table-wrap">
      <table className="t overview-table">
        <thead>
          <tr>
            <th>输入</th>
            <th>类型</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((i) => (
            <tr key={i.key}>
              <td>
                <strong>{i.label || i.key}</strong>
                {i.required ? <span className="badge warn ov-req">必填</span> : <span className="badge ov-req">可选</span>}
              </td>
              <td className="nowrap">{INPUT_TYPE_LABEL[i.type]}</td>
              <td className="ov-desc">
                {i.description && <div>{i.description}</div>}
                {i.defaultValue && <div className="small muted">不填时默认：{i.defaultValue}</div>}
                {!i.description && !i.defaultValue && <span className="muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldSummary({ fields }: { fields: OutputField[] }) {
  return (
    <div className="table-wrap">
      <table className="t overview-table">
        <thead>
          <tr>
            <th>结果项</th>
            <th>类型</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key}>
              <td>
                <strong>{f.label || f.key}</strong>
              </td>
              <td className="nowrap">{FIELD_TYPE_LABEL[f.type]}</td>
              <td className="ov-desc">
                {f.description && <div>{f.description}</div>}
                {f.type === 'enum' && !!f.options?.length && <div className="small muted">可能的取值：{f.options.join(' / ')}</div>}
                {f.type === 'object_list' && !!f.fields?.length && <div className="small muted">每一项包含：{f.fields.map((x) => x.label || x.key).join('、')}</div>}
                {!f.description && !(f.type === 'enum' && f.options?.length) && !(f.type === 'object_list' && f.fields?.length) && <span className="muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkillOverview({ id }: { id: string }) {
  const q = useLoad(() => api.skills.get(id), [id]);
  const packs = useLoad(() => api.rulePacks.list(), []);
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const s = q.data;
  const c = s.published ?? s.draft;
  const packNames = c.rulePackIds.map((pid) => packs.data?.find((p) => p.id === pid));
  return (
    <div className="overview" data-testid="skill-overview">
      <div className="page-head">
        <div>
          <h1 data-testid="skill-title">{s.name}</h1>
          <div className="row wrap small">
            <LifecycleBadge status={s.status} version={s.publishedVersion} />
            {s.category && <span className="badge">{s.category}</span>}
            {s.jurisdiction && <span className="badge">法域 {s.jurisdiction}</span>}
          </div>
        </div>
      </div>
      <div className="stack">
        <section className="panel">
          <h2 className="section">这个 Skill 做什么</h2>
          <p className="ov-lead">{s.description || <span className="muted">（无描述）</span>}</p>
          <p className="section-help" style={{ marginBottom: 0 }}>
            这里显示的是已发布的 v{s.publishedVersion}。Skill 的任务说明、测试和发布由创建者与法律审核人维护；需要使用时，请从下方的工作流运行。
          </p>
        </section>
        <section className="panel">
          <h2 className="section">需要的输入</h2>
          <InputSummary inputs={c.inputs} />
        </section>
        <section className="panel">
          <h2 className="section">输出</h2>
          {c.output.format === 'json' ? <FieldSummary fields={c.output.fields} /> : <p className="small">一份供人阅读的文本（Markdown 格式），可直接导出。</p>}
          {c.verification?.enabled && (
            <p className="small" style={{ marginBottom: 0 }}>
              结果会经过自动核验：引用的规则和原文是否存在、规则适用范围、风险等级是否合理。存疑的发现会标为“优先复核”。核验只决定复核顺序，所有发现仍需你确认。
            </p>
          )}
        </section>
        {c.rulePackIds.length > 0 && (
          <section className="panel">
            <h2 className="section">依据的规则包</h2>
            <ul className="ov-list">
              {c.rulePackIds.map((pid, i) => {
                const p = packNames[i];
                return (
                  <li key={pid}>
                    <span>{p?.name ?? pid}</span> {p && <LifecycleBadge status={p.status} version={p.approvedVersion} />}
                  </li>
                );
              })}
            </ul>
            <p className="section-help" style={{ marginBottom: 0 }}>
              正式运行只使用经法律审核批准的规则包版本。
            </p>
          </section>
        )}
        <section className="panel">
          <h2 className="section">在这些工作流中使用</h2>
          {s.usedBy.length ? (
            <ul className="ov-list">
              {s.usedBy.map((w) => (
                <li key={w.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <Link to={`/workflows/${w.id}`}>{w.name}</Link>
                  <Link className="btn sm primary" to={`/workflows/${w.id}/run`}>
                    运行
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small" style={{ marginBottom: 0 }}>
              暂未被已发布的工作流使用。
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

export function WorkflowOverview({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useLoad(() => api.workflows.get(id), [id]);
  const skillsQ = useLoad(() => api.skills.list(), []);
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const wf = q.data;
  const def = wf.published ?? wf.draft;
  const skills = new Map((skillsQ.data ?? []).map((s) => [s.id, s]));
  const info = Object.fromEntries(def.nodes.map((n) => [n.id, { sub: n.type === 'skill' ? skills.get(n.skillId)?.name ?? 'AI 步骤' : `人工审批 · ${ROLE_LABEL[n.approverRole]}` }]));
  return (
    <div className="overview" data-testid="workflow-overview">
      <div className="page-head">
        <div>
          <h1 data-testid="workflow-title">{wf.name}</h1>
          <div className="row wrap small">
            <LifecycleBadge status={wf.status} version={wf.publishedVersion} />
          </div>
        </div>
        <div className="actions">
          {can('workflow.run') && (
            <Link className="btn primary" to={`/workflows/${wf.id}/run`} data-testid="goto-run">
              运行
            </Link>
          )}
        </div>
      </div>
      <div className="stack">
        <section className="panel">
          <h2 className="section">用途</h2>
          <p className="ov-lead">{wf.description || <span className="muted">（无描述）</span>}</p>
          <p className="section-help" style={{ marginBottom: 0 }}>
            结果是 AI 初审意见，需要你复核后再使用；需要人工审批的步骤会自动通知法律审核人，审批结果会显示在运行记录中。
          </p>
        </section>
        <section className="panel">
          <h2 className="section">处理步骤</h2>
          <DagGraph nodes={def.nodes} info={info} testId="overview-dag" />
          <ol className="ov-steps">
            {def.nodes.map((n) => (
              <li key={n.id}>
                <strong>{n.name}</strong>
                <span className="small muted">
                  {n.type === 'skill' ? (
                    <>
                      {' '}
                      · AI：
                      {skills.get(n.skillId) ? <Link to={`/skills/${n.skillId}`}>{skills.get(n.skillId)!.name}</Link> : 'Skill'}
                    </>
                  ) : (
                    ` · 人工审批：${ROLE_LABEL[n.approverRole]}`
                  )}
                  {n.when ? ' · 满足条件时才运行' : ''}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel">
          <h2 className="section">运行时需要提供</h2>
          <InputSummary inputs={def.inputs} />
        </section>
      </div>
    </div>
  );
}
