import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PendingReviewRef, RulePackApproval, VersionInfo } from '../../shared/types';
import { AutoTextarea, ErrorNotice, fmtDate, fmtTime, useToast } from './ui';

const NOUN = { skill: 'Skill', workflow: '工作流', rulepack: '规则包' };

/**
 * Governance panel shown in every editor: what is live, what is pending, and how to get a draft
 * published (submit → reviewer approves → immutable new version).
 */
export default function PublishPanel({
  type,
  liveVersion,
  dirty,
  pendingReview,
  versions,
  approvals,
  canSubmit,
  unsaved,
  blocked,
  upgrade,
  onSubmit,
}: {
  type: 'skill' | 'workflow' | 'rulepack';
  liveVersion?: number;
  dirty: boolean;
  pendingReview?: PendingReviewRef;
  versions?: VersionInfo[];
  approvals?: RulePackApproval[];
  canSubmit: boolean;
  unsaved: boolean;
  blocked?: string;
  /** Workflows: newer skill versions exist than the ones pinned — re-submitting upgrades the pins. */
  upgrade?: string;
  onSubmit: (note: string) => Promise<unknown>;
}) {
  const submittable = dirty || !!upgrade;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  const noun = NOUN[type];
  const live = type === 'rulepack' ? '已批准' : '已发布';

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(note);
      setNote('');
      toast('已提交审核，等待审核人处理');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="publish-panel">
      <h2 className="section">发布与审核</h2>
      {pendingReview ? (
        <div className="notice warn small" data-testid="pending-review">
          <div className="title">审核中，内容已锁定</div>
          由 {pendingReview.submittedByName} 于 {fmtTime(pendingReview.createdAt)} 提交{pendingReview.note ? `：“${pendingReview.note}”` : ''}。{' '}
          <Link to={`/reviews/${pendingReview.id}`}>查看审核申请</Link>
        </div>
      ) : liveVersion ? (
        <p className="section-help">
          线上版本：<strong>v{liveVersion}</strong>（{live}）。{dirty ? `草稿有尚未${type === 'rulepack' ? '批准' : '发布'}的修改，正式运行仍使用 v${liveVersion}。` : '草稿与线上版本一致。'}
          {upgrade && <span data-testid="pin-upgrade"> {upgrade}</span>}
        </p>
      ) : (
        <p className="section-help">尚未{type === 'rulepack' ? '批准' : '发布'}。草稿只能用于测试运行；提交审核并由审核人批准后才能用于正式运行。</p>
      )}
      {type === 'rulepack' && (
        <p className="section-help">
          规则包须由具备资质的法律审核人逐条核对来源与适用范围，并在批准时签署审核声明（姓名、执业资格、复审截止日期）；过期后正式运行会被拦截。
        </p>
      )}
      {!pendingReview && canSubmit && (
        <div>
          <label className="field">
            <span className="lbl">变更说明（给审核人）</span>
            <AutoTextarea minRows={2} maxRows={8} value={note} onChange={(e) => setNote(e.target.value)} placeholder="改了什么、为什么改（可选）" data-testid="submit-note" />
          </label>
          <button type="button" className="primary" onClick={submit} disabled={busy || unsaved || (!submittable && !!liveVersion) || !!blocked} data-testid="submit-review">
            {busy ? '提交中…' : `提交${noun}审核`}
          </button>
          <div className="field-help">
            {unsaved ? '请先保存草稿再提交。' : blocked ? blocked : !submittable && liveVersion ? '草稿与线上版本一致，无需提交。' : '组织启用“四眼原则”时，提交人不能批准自己的申请。'}
          </div>
        </div>
      )}
      <ErrorNotice error={error} />
      {(versions?.length || approvals?.length) ? (
        <details className="adv" style={{ marginTop: 10 }}>
          <summary>版本历史（{versions?.length ?? approvals?.length}）</summary>
          <table className="t small" data-testid="version-history">
            <tbody>
              {(versions ?? [])
                .slice()
                .reverse()
                .map((v) => (
                  <tr key={v.version}>
                    <td>v{v.version}</td>
                    <td>{v.approvedByName ?? '-'}</td>
                    <td>{fmtDate(v.approvedAt)}</td>
                    <td className="muted">{v.changelog ?? ''}</td>
                  </tr>
                ))}
              {(approvals ?? [])
                .slice()
                .reverse()
                .map((a) => (
                  <tr key={a.version}>
                    <td>v{a.version}</td>
                    <td>
                      {a.approverName}
                      <div className="muted">{a.approverQualification}</div>
                    </td>
                    <td>{fmtDate(a.approvedAt)}</td>
                    <td className="muted">复审截止 {fmtDate(a.reviewDueAt)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}
