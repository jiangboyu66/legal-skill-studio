import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNotice, fmtDuration, fmtTime, Loading, ModeBadge, RunModeBadge, StatusBadge, useAuth, useLoad } from '../components/ui';

export default function RunsList() {
  const { can } = useAuth();
  const { data: runs, error } = useLoad(() => api.runs.list(), []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>运行记录</h1>
          <p>
            每次运行都保存当时使用的工作流、Skill 与规则包版本、实际输入、AI 的工具调用过程、核验结果和人工审批记录，便于追溯和复核。
            {can('run.view_all') ? '你可以查看组织内所有人的运行。' : '你只能看到自己发起的运行。'}
          </p>
        </div>
      </div>
      <ErrorNotice error={error} />
      {!runs && !error && <Loading />}
      {runs && (
        <div className="list">
          {runs.length === 0 ? (
            <div className="empty">还没有运行记录。到“工作流”选择一个工作流运行。</div>
          ) : (
            <table className="t" data-testid="runs-table">
              <thead>
                <tr>
                  <th>开始时间</th>
                  <th>工作流</th>
                  <th>状态</th>
                  <th>发起人</th>
                  <th>模型</th>
                  <th>用时</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/runs/${r.id}`}>{fmtTime(r.createdAt)}</Link>
                    </td>
                    <td>
                      {r.workflowName} <RunModeBadge mode={r.mode} />
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="small">{r.startedByName}</td>
                    <td>
                      <ModeBadge mode={r.provider.mode} /> <span className="small muted">{r.provider.model}</span>
                    </td>
                    <td>{fmtDuration(r.createdAt, r.finishedAt)}</td>
                    <td className="small">
                      {r.failedNode ? `「${r.failedNode}」失败（${r.errorCode}）` : r.waitingNode ? `等待「${r.waitingNode}」审批` : <span className="muted">{r.nodeCount} 个节点</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
