import { Link } from 'react-router-dom';
import { ROLE_LABEL } from '../../shared/schema';
import { api } from '../api';
import { ErrorNotice, fmtTime, Loading, RunModeBadge, useLoad } from '../components/ui';

const TYPE: Record<string, string> = { skill: 'Skill', workflow: '工作流', rulepack: '规则包' };
const STATUS: Record<string, [string, string]> = { pending: ['待审核', 'warn'], approved: ['已批准', 'ok'], rejected: ['已驳回', 'bad'], withdrawn: ['已撤回', ''] };

export default function Reviews() {
  const { data, error } = useLoad(() => api.reviews.inbox(), []);
  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Loading />;
  const pending = data.requests.filter((r) => r.status === 'pending');
  const history = data.requests.filter((r) => r.status !== 'pending');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>审核与审批</h1>
          <p>
            两类待办：<strong>发布申请</strong>（Skill、工作流、规则包的草稿要经审核人批准后才能用于正式运行，每次批准生成不可修改的新版本）与<strong>运行中的审批</strong>（工作流中的人工审批节点，或 AI 申请使用需确认的工具）。组织启用“四眼原则”时，提交人/发起人不能批准自己的事项。
          </p>
        </div>
      </div>

      <section className="panel" data-testid="node-approvals">
        <h2 className="section">运行中的审批（{data.nodeApprovals.length}）</h2>
        {data.nodeApprovals.length === 0 ? (
          <div className="muted small">没有等待审批的运行。</div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>工作流</th>
                <th>节点</th>
                <th>审批角色</th>
                <th>发起人</th>
                <th>时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.nodeApprovals.map((a) => (
                <tr key={`${a.runId}-${a.nodeId}`}>
                  <td>
                    {a.workflowName} <RunModeBadge mode={a.mode} />
                  </td>
                  <td>{a.tool ? `工具申请：${a.tool}（${a.nodeName}）` : a.nodeName}</td>
                  <td>{ROLE_LABEL[a.approverRole]}</td>
                  <td>{a.startedByName}</td>
                  <td className="small">{fmtTime(a.requestedAt)}</td>
                  <td>
                    {a.canDecide ? (
                      <Link className="btn sm primary" to={`/runs/${a.runId}`} data-testid={`open-approval-${a.nodeId}`}>
                        去审批
                      </Link>
                    ) : (
                      <span className="small muted">
                        {a.blockedReason} · <Link to={`/runs/${a.runId}`}>查看</Link>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" data-testid="review-requests">
        <h2 className="section">待处理的发布申请（{pending.length}）</h2>
        {pending.length === 0 ? (
          <div className="muted small">没有待处理的发布申请。</div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>类型</th>
                <th>名称</th>
                <th>提交人</th>
                <th>时间</th>
                <th>说明</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="badge">{TYPE[r.entityType]}</span>
                  </td>
                  <td>{r.entityName}</td>
                  <td>{r.submittedByName}</td>
                  <td className="small">{fmtTime(r.createdAt)}</td>
                  <td className="small muted">{r.note}</td>
                  <td>
                    <Link className={`btn sm ${r.canDecide ? 'primary' : ''}`} to={`/reviews/${r.id}`} data-testid={`open-review-${r.entityType}`}>
                      {r.canDecide ? '审核' : '查看'}
                    </Link>
                    {r.blockedReason && <div className="small muted">{r.blockedReason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {history.length > 0 && (
        <section className="panel">
          <h2 className="section">历史记录</h2>
          <table className="t small">
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={`badge ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                  </td>
                  <td>
                    {TYPE[r.entityType]}「<Link to={`/reviews/${r.id}`}>{r.entityName}</Link>」
                  </td>
                  <td>提交：{r.submittedByName}</td>
                  <td>处理：{r.decidedByName ?? '-'}</td>
                  <td>{fmtTime(r.decidedAt)}</td>
                  <td className="muted">{r.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
