import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNotice, fmtDate, LifecycleBadge, Loading, useAuth, useLoad } from '../components/ui';

export default function RulePacksList() {
  const { can } = useAuth();
  const { data: packs, error } = useLoad(() => api.rulePacks.list(), []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>规则包</h1>
          <p>
            规则包是 Skill 判断时依据的法规、行业准则或公司政策条目。每条规则标注来源和核实程度；整包必须由具备资质的法律审核人逐条核对并签署审核声明后，才能用于正式运行，且到期需要复审。
          </p>
        </div>
        <div className="actions">
          {can('rulepack.edit') && (
            <Link className="btn primary" to="/rulepacks/new" data-testid="new-rulepack">
              新建规则包
            </Link>
          )}
        </div>
      </div>
      <ErrorNotice error={error} />
      {!packs && !error && <Loading />}
      {packs && (
        <div className="list" data-testid="rulepacks-list">
          {packs.length === 0 && <div className="empty">还没有规则包。</div>}
          {packs.map((p) => (
            <div className="item" key={p.id}>
              <div>
                <h3>
                  <Link to={`/rulepacks/${p.id}`}>{p.name}</Link>
                </h3>
                <p>{p.description || <span className="muted">（无描述）</span>}</p>
                <div className="row wrap small">
                  <LifecycleBadge status={p.status} version={p.approvedVersion} dirty={p.dirty} />
                  <span className="badge">法域 {p.jurisdiction}</span>
                  <span className="muted">
                    {p.stats.total} 条规则：原文已核对 {p.stats.verbatim} · 转述 {p.stats.paraphrased} · 未核实 {p.stats.unverified}
                  </span>
                  {p.approval && (
                    <span className="muted">
                      · 审核人 {p.approval.approverName}，复审截止 {fmtDate(p.approval.reviewDueAt)}
                    </span>
                  )}
                  {p.source !== 'user' && <span className="badge">来自插件</span>}
                </div>
              </div>
              <div className="actions">
                <Link className="btn sm" to={`/rulepacks/${p.id}`}>
                  {can('rulepack.edit') ? '编辑' : '查看'}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
