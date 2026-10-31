import { useRef, useState } from 'react';
import type { DemoAccounts, Me, Meta } from '../../shared/types';
import { api } from '../api';
import { ErrorNotice, RoleBadge, useLoad } from '../components/ui';

const ROLE_HELP: Record<string, string> = {
  admin: '全部功能：用户与角色、组织策略、审计日志，以及创建、审核和运行',
  builder: '创建和编辑 Skill、规则包、工作流草稿，测试运行，提交发布申请',
  reviewer: '审核发布申请、签署规则包审核声明、处理运行中的人工审批节点',
  runner: '只使用已发布的工作流处理材料、复核并导出结果；看不到编辑区和审核区',
};

type Account = DemoAccounts['accounts'][number];

export default function Login({ meta, onLogin }: { meta: Meta | null; onLogin: (me: Me) => void }) {
  const demo = useLoad(() => api.auth.demoAccounts(), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [filled, setFilled] = useState<Account>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const submitRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await api.auth.login(email, password));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Only fills the form: signing in still goes through the 登录 button, like a real account. */
  function fill(a: Account) {
    setEmail(a.email);
    setPassword(a.password ?? '');
    setFilled(a);
    setError(undefined);
    setTimeout(() => (a.password ? submitRef.current : passwordRef.current)?.focus(), 0);
  }

  const accounts = demo.data?.accounts ?? [];
  const filledStill = filled && filled.email === email && (filled.password ?? '') === password;

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand dark">Legal Skill Studio</div>
        <p className="muted" style={{ marginTop: 0 }}>法律 Skill 与工作流自助创建平台 · v{meta?.appVersion ?? '3'}</p>
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            login();
          }}
        >
          <label className="field">
            <span className="lbl">账号（邮箱）</span>
            <input type="text" autoComplete="username" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="login-email" />
          </label>
          <label className="field">
            <span className="lbl">密码</span>
            <span className="input-affix">
              <input
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="login-password"
              />
              <button type="button" className="ghost sm" onClick={() => setShowPassword((v) => !v)} aria-pressed={showPassword} aria-label={showPassword ? '隐藏密码' : '显示密码'}>
                {showPassword ? '隐藏' : '显示'}
              </button>
            </span>
          </label>
          <button ref={submitRef} type="submit" className="primary login-submit" disabled={busy || !email || !password} data-testid="login-submit">
            {busy ? '正在登录…' : '登录'}
          </button>
          <p className="small muted login-hint" aria-live="polite" data-testid="login-filled">
            {filledStill ? (filled.password ? `已填入「${filled.name}」的账号和密码，点「登录」进入。` : `已填入「${filled.name}」的账号；此账号密码已修改，请输入新密码。`) : ' '}
          </p>
        </form>
        <ErrorNotice error={error} />
        {accounts.length > 0 && (
          <section className="test-accounts" data-testid="demo-accounts">
            <h2 className="section">测试账号</h2>
            <p className="section-help">
              每个角色一个账号，各有独立密码。点「填入」只会把账号和密码填进上面的表单，仍需点「登录」。不同角色看到的功能不同；因为“四眼原则”要求提交人和审批人不是同一个人，审核人有两个账号。仅用于原型演示，正式环境请设置 <code>DEMO_ACCOUNTS=false</code> 并修改全部密码。
            </p>
            <div className="table-wrap">
              <table className="t accounts">
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>账号</th>
                    <th>密码</th>
                    <th>可以做什么</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const id = a.email.split('@')[0];
                    return (
                      <tr key={a.email} className={filledStill && filled?.email === a.email ? 'on' : undefined} data-testid={`account-${id}`}>
                        <td data-label="角色">
                          <RoleBadge role={a.role} />
                        </td>
                        <td data-label="账号">
                          <div className="acc-name">{a.name.replace(/（.*）$/, '')}</div>
                          <code className="acc-mono">{a.email}</code>
                        </td>
                        <td data-label="密码">
                          {a.password ? <code className="acc-mono">{a.password}</code> : <span className="small muted">已修改，请向管理员索取</span>}
                        </td>
                        <td data-label="可以做什么" className="acc-help">
                          {ROLE_HELP[a.role]}
                        </td>
                        <td className="acc-act">
                          <button type="button" className="sm" onClick={() => fill(a)} disabled={busy} data-testid={`fill-${id}`} aria-label={`填入${a.name}的账号和密码`}>
                            填入
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
