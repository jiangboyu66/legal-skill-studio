import { useState } from 'react';
import { ACTIONS, ROLE_LABEL } from '../../shared/schema';
import type { OrgPolicy, Role, User } from '../../shared/types';
import { api } from '../api';
import { AutoTextarea, ErrorNotice, fmtTime, Loading, RoleBadge, useAuth, useLoad, useToast } from '../components/ui';

type Tab = 'users' | 'policy' | 'audit' | 'platform';
const ROLES: Role[] = ['admin', 'builder', 'reviewer', 'runner'];

export default function Admin() {
  const { can } = useAuth();
  const tabs: [Tab, string, boolean][] = [
    ['users', '用户与角色', can('admin.users')],
    ['policy', '组织策略', can('admin.policy')],
    ['audit', '审计日志', can('audit.view')],
    ['platform', '平台扩展', true],
  ];
  const visible = tabs.filter((t) => t[2]);
  const [tab, setTab] = useState<Tab>(visible[0][0]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>组织管理</h1>
          <p>账户与角色、组织策略（允许 / 需确认 / 禁止）、审计日志，以及平台的插件、工具、代理、钩子和功能开关。</p>
        </div>
      </div>
      <div className="tabs">
        {visible.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`admin-tab-${k}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'users' && <Users />}
      {tab === 'policy' && <Policy />}
      {tab === 'audit' && <Audit />}
      {tab === 'platform' && <Platform />}
    </>
  );
}

function Users() {
  const { me } = useAuth();
  const toast = useToast();
  const q = useLoad(() => api.admin.users(), []);
  const [form, setForm] = useState({ email: '', name: '', role: 'runner' as Role, password: '' });
  const [error, setError] = useState<unknown>();
  const update = async (u: User, patch: Partial<User> & { password?: string }) => {
    setError(undefined);
    try {
      await api.admin.updateUser(u.id, patch);
      toast('已更新');
      q.reload();
    } catch (e) {
      setError(e);
    }
  };
  if (!q.data) return q.error ? <ErrorNotice error={q.error} /> : <Loading />;
  return (
    <div className="stack">
      <ErrorNotice error={error} />
      <div className="list">
        <table className="t" data-testid="users-table">
          <thead>
            <tr>
              <th>姓名</th>
              <th>邮箱</th>
              <th>角色</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name}
                  <div className="small muted">{u.title}</div>
                </td>
                <td className="small">{u.email}</td>
                <td>
                  <select value={u.role} disabled={u.id === me.user.id} onChange={(e) => update(u, { role: e.target.value as Role })} aria-label={`${u.name} 的角色`}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{u.disabled ? <span className="badge bad">已停用</span> : <span className="badge ok">正常</span>}</td>
                <td>
                  {u.id !== me.user.id && (
                    <button className="sm" onClick={() => update(u, { disabled: !u.disabled })}>
                      {u.disabled ? '启用' : '停用'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="panel">
        <h2 className="section">添加用户</h2>
        <div className="cols-2">
          <label className="field">
            <span className="lbl">邮箱</span>
            <input type="text" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            <span className="lbl">姓名</span>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span className="lbl">角色</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lbl">初始密码（≥ 8 位）</span>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={{ width: '100%' }} />
          </label>
        </div>
        <button
          className="primary"
          onClick={async () => {
            setError(undefined);
            try {
              await api.admin.createUser(form);
              setForm({ email: '', name: '', role: 'runner', password: '' });
              toast('已添加用户');
              q.reload();
            } catch (e) {
              setError(e);
            }
          }}
        >
          添加
        </button>
      </section>
    </div>
  );
}

const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);

const matches = (rule: string, action: string) => rule === '*' || rule === action || (rule.endsWith('*') && action.startsWith(rule.slice(0, -1)));

function Policy() {
  const { me, setMe } = useAuth();
  const platform = useLoad(() => api.admin.platform(), []);
  const roleAllows = (r: Role, a: string) => (platform.data?.roles[r] ?? []).some((x) => matches(x, a));
  const toast = useToast();
  const p = me.org.policy;
  const [allow, setAllow] = useState(p.permissions.allow.join('\n'));
  const [ask, setAsk] = useState(p.permissions.ask.join('\n'));
  const [deny, setDeny] = useState(p.permissions.deny.join('\n'));
  const [rp, setRp] = useState(p.requireApprovedRulePacks);
  const [four, setFour] = useState(p.requireDistinctApprover);
  const [ci, setCi] = useState(p.customInstructions);
  const [error, setError] = useState<unknown>();
  async function save() {
    setError(undefined);
    const policy: OrgPolicy = { permissions: { allow: lines(allow), ask: lines(ask), deny: lines(deny) }, requireApprovedRulePacks: rp, requireDistinctApprover: four, customInstructions: ci };
    try {
      setMe(await api.admin.updatePolicy(policy));
      toast('策略已保存，立即生效');
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="grid-2">
      <section className="panel" data-testid="policy-editor">
        <h2 className="section">权限规则</h2>
        <p className="section-help">
          在角色权限基础上调整，优先级：禁止 &gt; 未授权 &gt; 需确认 &gt; 允许。规则可写具体操作（<code>workflow.run</code>）、通配（<code>skill.*</code>）或 AI 工具（<code>tool:lookup_rule</code>、<code>tool:*</code>）。“需确认”用于 AI 工具：运行到该处时暂停，由审核人批准后继续。
        </p>
        <div className="cols-2">
          <label className="field">
            <span className="lbl">额外允许（allow）</span>
            <textarea className="code" rows={4} value={allow} onChange={(e) => setAllow(e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">需确认（ask）</span>
            <textarea className="code" rows={4} value={ask} onChange={(e) => setAsk(e.target.value)} data-testid="policy-ask" />
          </label>
        </div>
        <label className="field">
          <span className="lbl">禁止（deny）</span>
          <textarea className="code" rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} />
        </label>
        <label className="check" style={{ display: 'flex', marginBottom: 8 }}>
          <input type="checkbox" checked={rp} onChange={(e) => setRp(e.target.checked)} /> 正式运行只能使用经法律审核批准且未过期的规则包
        </label>
        <label className="check" style={{ display: 'flex', marginBottom: 8 }}>
          <input type="checkbox" checked={four} onChange={(e) => setFour(e.target.checked)} /> 四眼原则：提交人 / 运行发起人不能批准自己的事项
        </label>
        <label className="field">
          <span className="lbl">组织级 AI 指令（加入每个代理的系统提示词）</span>
          <AutoTextarea minRows={3} maxRows={12} value={ci} onChange={(e) => setCi(e.target.value)} aria-describedby="org-ci-help" />
          <div className="field-help" id="org-ci-help">
            例如：使用新加坡英语拼写；涉及医疗声明一律标为需人工复核。
          </div>
        </label>
        <button className="primary" onClick={save} data-testid="save-policy">
          保存策略
        </button>
        <ErrorNotice error={error} />
      </section>
      <section className="panel small">
        <h2 className="section">各角色的默认权限</h2>
        <div className="table-scroll">
        <table className="t">
          <thead>
            <tr>
              <th>操作</th>
              {ROLES.map((r) => (
                <th key={r}>
                  <RoleBadge role={r} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(ACTIONS).map(([a, label]) => (
              <tr key={a}>
                <td>
                  {label} <code className="muted">{a}</code>
                </td>
                {ROLES.map((r) => (
                  <td key={r}>{roleAllows(r, a) ? '✓' : ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>
    </div>
  );
}

function Audit() {
  const q = useLoad(() => api.admin.audit(), []);
  if (!q.data) return q.error ? <ErrorNotice error={q.error} /> : <Loading />;
  return (
    <div className="list">
      <table className="t small" data-testid="audit-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>操作人</th>
            <th>操作</th>
            <th>对象</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((e) => (
            <tr key={e.id}>
              <td>{fmtTime(e.at)}</td>
              <td>{e.userName ?? <span className="muted">系统</span>}</td>
              <td>
                <code>{e.action}</code>
              </td>
              <td className="mono">{e.entityId}</td>
              <td className="mono muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {e.detail ? JSON.stringify(e.detail).slice(0, 200) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Platform() {
  const q = useLoad(() => api.admin.platform(), []);
  if (!q.data) return q.error ? <ErrorNotice error={q.error} /> : <Loading />;
  const p = q.data;
  return (
    <div className="grid-2" data-testid="platform-info">
      <div className="stack">
        <section className="panel">
          <h2 className="section">插件</h2>
          <p className="section-help">插件以声明方式提供 Skill、规则包、工作流模板和代理定义；第三方插件不能在服务器上执行代码。插件带来的规则包需经本组织审核后才能用于正式运行。</p>
          {p.plugins.map((x) => (
            <div key={x.name} className="small" style={{ marginBottom: 8 }}>
              <strong>{x.name}</strong> v{x.version} {x.builtIn && <span className="badge">内置</span>}
              <div className="muted">{x.description}</div>
              <div>Skills：{x.contributes.skills.join('、')}</div>
              <div>规则包：{x.contributes.rulePacks.join('、')}；工作流：{x.contributes.workflows.join('、')}</div>
            </div>
          ))}
        </section>
        <section className="panel">
          <h2 className="section">代理（Agents）</h2>
          {p.agents.map((a) => (
            <div key={a.agentType} className="small" style={{ marginBottom: 6 }}>
              <code>{a.agentType}</code> <span className="muted">{a.source}</span>
              <div>{a.description}</div>
              <div className="muted">工具：{a.tools.join(', ')}</div>
            </div>
          ))}
        </section>
      </div>
      <div className="stack">
        <section className="panel">
          <h2 className="section">工具（Tools）</h2>
          {p.tools.map((t) => (
            <div key={t.name} className="small" style={{ marginBottom: 6 }}>
              <code>{t.name}</code> {t.readOnly && <span className="badge">只读</span>}
              <div className="muted">{t.description.split('\n')[0]}</div>
            </div>
          ))}
        </section>
        <section className="panel">
          <h2 className="section">钩子（Hooks）</h2>
          {p.hooks.map((h, i) => (
            <div key={i} className="small">
              <code>{h.event}</code> {h.name} — <span className="muted">{h.description}</span>
            </div>
          ))}
        </section>
        <section className="panel">
          <h2 className="section">功能开关</h2>
          <p className="section-help">通过环境变量 FEATURES 调整，例如 FEATURES=-VERIFIER_AGENT,-VISION。</p>
          {Object.entries(p.features).map(([k, v]) => (
            <div key={k} className="small">
              <code>{k}</code> {v ? <span className="badge ok">开</span> : <span className="badge">关</span>}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
