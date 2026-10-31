import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { Me, Meta } from '../shared/types';
import { api, setUnauthenticatedHandler } from './api';
import { AuthCtx, type AuthState, Loading, MetaCtx, RoleBadge, useAuth, useLoad } from './components/ui';
import Admin from './pages/Admin';
import Documents from './pages/Documents';
import Login from './pages/Login';
import ReviewDetail from './pages/ReviewDetail';
import Reviews from './pages/Reviews';
import RulePackEditor from './pages/RulePackEditor';
import RulePacksList from './pages/RulePacksList';
import RunCompare from './pages/RunCompare';
import RunDetail from './pages/RunDetail';
import RunStart from './pages/RunStart';
import RunsList from './pages/RunsList';
import SkillEditor from './pages/SkillEditor';
import SkillsList from './pages/SkillsList';
import WorkflowEditor from './pages/WorkflowEditor';
import WorkflowsList from './pages/WorkflowsList';

function InboxCount() {
  const location = useLocation();
  const { data, reload } = useLoad(() => api.reviews.inbox(), [location.pathname]);
  useEffect(() => {
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);
  const n = (data?.requests.filter((r) => r.canDecide).length ?? 0) + (data?.nodeApprovals.filter((a) => a.canDecide).length ?? 0);
  return n ? (
    <span className="count" data-testid="inbox-count">
      {n}
    </span>
  ) : null;
}

/** Actions that open each restricted area (any one is enough). Menus and routes use the same lists. */
const AREA = {
  rulepacks: ['rulepack.edit', 'rulepack.approve'],
  reviews: ['review.view'],
  admin: ['admin.users', 'admin.policy', 'audit.view'],
  newSkill: ['skill.edit'],
  newWorkflow: ['workflow.edit'],
  run: ['workflow.run', 'workflow.test'],
};

function Forbidden() {
  return (
    <div className="empty" data-testid="forbidden">
      <h2 style={{ marginTop: 0 }}>没有权限访问此页面</h2>
      <p>当前角色不能使用这个功能。如需开通，请联系组织管理员。</p>
      <Link className="btn" to="/workflows">
        返回工作流
      </Link>
    </div>
  );
}

/** Route guard: the server enforces the same permissions; this only avoids showing pages that would fail. */
function Guard({ any, children }: { any: string[]; children: ReactNode }) {
  const { can } = useAuth();
  return any.some(can) ? <>{children}</> : <Forbidden />;
}

function Shell({ meta }: { meta: Meta | null }) {
  const { me, logout, can } = useAuth();
  const may = (area: keyof typeof AREA) => AREA[area].some(can);
  return (
    <div className="shell">
      <nav className="side" aria-label="主导航">
        <div className="brand">Legal Skill Studio</div>
        <div className="brand-sub">{me.org.name}</div>
        <NavLink to="/workflows">工作流</NavLink>
        <NavLink to="/skills">Skills</NavLink>
        {may('rulepacks') && <NavLink to="/rulepacks">规则包</NavLink>}
        {may('reviews') && (
          <NavLink to="/reviews" data-testid="nav-reviews">
            审核与审批 <InboxCount />
          </NavLink>
        )}
        <NavLink to="/runs">运行记录</NavLink>
        <NavLink to="/documents">物料文件</NavLink>
        {may('admin') && <NavLink to="/admin">组织管理</NavLink>}
        <div className="spacer" />
        {meta && (
          <div className={`mode ${meta.provider.mode}`} data-testid="provider-mode">
            {meta.provider.mode === 'mock' ? (
              <>
                <strong>模拟模式</strong>
                {may('admin') ? '未配置模型密钥，结果由程序生成，仅用于演示流程。在 .env 中配置 API Key（如 DEEPSEEK_API_KEY）并重启即可切换为真实模型。' : '结果由程序生成，仅用于演示流程，不是真实的 AI 审查意见。'}
              </>
            ) : (
              <>
                <strong>真实模型</strong>
                {meta.provider.name} / {meta.provider.model}
              </>
            )}
          </div>
        )}
        <div className="me" data-testid="current-user">
          <div className="me-name">{me.user.name}</div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <RoleBadge role={me.user.role} />
            <button type="button" className="ghost sm" onClick={logout} data-testid="logout">
              退出
            </button>
          </div>
        </div>
      </nav>
      <main className="main">
        <div className="page">
          <Routes>
            <Route path="/" element={<Navigate to="/workflows" replace />} />
            <Route path="/login" element={<Navigate to="/workflows" replace />} />
            <Route path="/skills" element={<SkillsList />} />
            <Route path="/skills/new" element={<Guard any={AREA.newSkill}><SkillEditor /></Guard>} />
            <Route path="/skills/:id" element={<SkillEditor />} />
            <Route path="/rulepacks" element={<Guard any={AREA.rulepacks}><RulePacksList /></Guard>} />
            <Route path="/rulepacks/new" element={<Guard any={['rulepack.edit']}><RulePackEditor /></Guard>} />
            <Route path="/rulepacks/:id" element={<Guard any={AREA.rulepacks}><RulePackEditor /></Guard>} />
            <Route path="/workflows" element={<WorkflowsList />} />
            <Route path="/workflows/new" element={<Guard any={AREA.newWorkflow}><WorkflowEditor /></Guard>} />
            <Route path="/workflows/:id" element={<WorkflowEditor />} />
            <Route path="/workflows/:id/run" element={<Guard any={AREA.run}><RunStart /></Guard>} />
            <Route path="/reviews" element={<Guard any={AREA.reviews}><Reviews /></Guard>} />
            <Route path="/reviews/:id" element={<Guard any={AREA.reviews}><ReviewDetail /></Guard>} />
            <Route path="/runs" element={<RunsList />} />
            <Route path="/runs/compare" element={<RunCompare />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/admin" element={<Guard any={AREA.admin}><Admin /></Guard>} />
            <Route path="*" element={<div className="empty">页面不存在。</div>} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const navigate = useNavigate();

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
    api.auth
      .me()
      .then(setMe)
      .catch(() => setMe(null));
    setUnauthenticatedHandler(() => setMe(null));
  }, []);

  const logout = useCallback(() => {
    api.auth.logout().finally(() => {
      setMe(null);
      navigate('/login');
    });
  }, [navigate]);

  const auth = useMemo<AuthState | null>(() => (me ? { me, setMe, logout, can: (a: string) => me.can[a] === 'allow' } : null), [me, logout]);

  return (
    <MetaCtx.Provider value={meta}>
      {me === undefined ? (
        <Loading />
      ) : !auth ? (
        <Login meta={meta} onLogin={setMe} />
      ) : (
        <AuthCtx.Provider value={auth}>
          <Shell meta={meta} />
        </AuthCtx.Provider>
      )}
    </MetaCtx.Provider>
  );
}
