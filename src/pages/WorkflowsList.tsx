import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNotice, fmtTime, LifecycleBadge, Loading, useAuth, useLoad } from '../components/ui';

export default function WorkflowsList() {
  const { can } = useAuth();
  const consumer = !can('workflow.edit') && !can('workflow.approve');
  const { data: list, error } = useLoad(() => api.workflows.list(), []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>工作流</h1>
          {consumer ? (
            <p>选择一个已发布的工作流，上传或粘贴材料即可运行。结果是 AI 初审意见，需要你复核后再使用；需要人工审批的步骤会自动交给法律审核人。</p>
          ) : (
            <p>把多个 Skill 和人工审批节点组成有向图：节点可以并行、按条件分支，并在关键处等待法律审核人批准。正式运行只使用已发布的版本。</p>
          )}
        </div>
        <div className="actions">
          {can('workflow.edit') && (
            <Link className="btn primary" to="/workflows/new" data-testid="new-workflow">
              新建工作流
            </Link>
          )}
        </div>
      </div>
      <ErrorNotice error={error} />
      {!list && !error && <Loading />}
      {list && (
        <div className="list" data-testid="workflows-list">
          {list.length === 0 && <div className="empty">{consumer ? '还没有已发布的工作流。' : '还没有工作流。'}</div>}
          {list.map((w) => {
            const def = w.published ?? w.draft;
            const errors = w.issues.filter((i) => i.level === 'error').length;
            const approvals = def.nodes.filter((n) => n.type === 'approval').length;
            const conditional = def.nodes.filter((n) => n.when).length;
            return (
              <div className="item" key={w.id} data-testid={`workflow-${w.id}`}>
                <div>
                  <h3>
                    <Link to={`/workflows/${w.id}`}>{w.name}</Link>
                  </h3>
                  <p>{w.description || <span className="muted">（无描述）</span>}</p>
                  <div className="row wrap small">
                    <LifecycleBadge status={w.status} version={w.publishedVersion} dirty={w.dirty} />
                    <span className="muted">
                      {def.nodes.length} 个节点{conditional ? ` · ${conditional} 个条件分支` : ''}
                      {approvals ? ` · ${approvals} 个人工审批` : ''} · 更新于 {fmtTime(w.updatedAt)}
                    </span>
                    {w.source !== 'user' && <span className="badge">来自插件</span>}
                    {errors > 0 && <span className="badge bad">草稿有 {errors} 处配置错误</span>}
                  </div>
                </div>
                <div className="actions">
                  <Link className="btn sm" to={`/workflows/${w.id}`}>
                    {can('workflow.edit') ? '编辑' : consumer ? '说明' : '查看'}
                  </Link>
                  {(w.publishedVersion ? can('workflow.run') : can('workflow.test')) && (
                    <Link className="btn sm primary" to={`/workflows/${w.id}/run`} data-testid={`run-${w.id}`}>
                      运行
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
