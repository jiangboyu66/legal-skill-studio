import { Router } from 'express';
import { ROLE_LABEL } from '../../shared/schema';
import type { NodeApprovalItem, Org, ReviewDetail, ReviewInbox, ReviewRequest, ReviewRequestView, RulePackContent, SkillConfig, User } from '../../shared/types';
import { configHash } from '../core/eval';
import type { AppContext } from '../context';
import type { RulePackAttestation } from '../core/governance';
import { sourceStats } from '../core/rulePacks';
import { Errors } from '../errors';
import { requirePermission } from '../core/permissions';
import { can, h, param, text, who } from './util';

export function reviewsRouter(ctx: AppContext) {
  const r = Router();
  const { db } = ctx;

  const toView = (req: ReviewRequest, user: User, org: Org): ReviewRequestView => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { snapshot, ...rest } = req;
    let blockedReason: string | undefined;
    const allowed = can(user, org, `${req.entityType}.approve`);
    if (req.status === 'pending' && allowed && org.policy.requireDistinctApprover && req.submittedBy === user.id) blockedReason = '四眼原则：不能审批自己提交的申请';
    return {
      ...rest,
      canDecide: req.status === 'pending' && allowed && !blockedReason,
      canWithdraw: req.status === 'pending' && (req.submittedBy === user.id || user.role === 'admin'),
      blockedReason,
    };
  };

  r.get(
    '/',
    h((req): ReviewInbox => {
      const { user, org } = who(req);
      requirePermission(user, org, 'review.view');
      const visible = (t: string) => can(user, org, `${t}.view`);
      const requests = db.reviews
        .list(org.id)
        .filter((x) => visible(x.entityType))
        .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100)
        .map((x) => toView(x, user, org));
      const nodeApprovals: NodeApprovalItem[] = [];
      const mayApprove = can(user, org, 'run.approve_node');
      for (const run of db.runsByStatus(['waiting_approval', 'running'])) {
        if (run.orgId !== org.id) continue;
        if (!mayApprove && run.startedBy !== user.id) continue;
        for (const id of run.order) {
          const n = run.nodes[id];
          if (n.status !== 'waiting_approval' || !n.approvalRequest) continue;
          let blockedReason: string | undefined;
          if (!mayApprove) blockedReason = '没有审批权限';
          else if (user.role !== 'admin' && user.role !== n.approvalRequest.approverRole) blockedReason = `需要「${ROLE_LABEL[n.approvalRequest.approverRole]}」角色`;
          else if (org.policy.requireDistinctApprover && run.startedBy === user.id) blockedReason = '四眼原则：不能审批自己发起的运行';
          nodeApprovals.push({
            runId: run.id,
            workflowName: run.workflowName,
            mode: run.mode,
            nodeId: id,
            nodeName: n.name,
            approverRole: n.approvalRequest.approverRole,
            tool: n.approvalRequest.tool,
            reason: n.approvalRequest.reason,
            startedByName: run.startedByName,
            requestedAt: n.startedAt ?? n.finishedAt,
            canDecide: !blockedReason,
            blockedReason,
          });
        }
      }
      return { requests, nodeApprovals };
    }),
  );

  r.get(
    '/:id',
    h((req): ReviewDetail => {
      const { user, org } = who(req);
      requirePermission(user, org, 'review.view');
      const rv = db.reviews.get(org.id, param(req, 'id'));
      if (!rv || !can(user, org, `${rv.entityType}.view`)) throw Errors.notFound('审核申请');
      const e = rv.entityType === 'skill' ? db.skills.get(org.id, rv.entityId) : rv.entityType === 'workflow' ? db.workflows.get(org.id, rv.entityId) : db.rulePacks.get(org.id, rv.entityId);
      const entity = { id: rv.entityId, name: e?.name ?? rv.entityName, description: e?.description ?? '', source: e?.source ?? 'user' };
      const base = { request: { ...toView(rv, user, org), snapshot: rv.snapshot }, entity };
      if (rv.entityType === 'rulepack') {
        const p = e as import('../../shared/types').RulePack | undefined;
        return { ...base, current: p?.approved, currentVersion: p?.approvedVersion, stats: sourceStats(rv.snapshot as RulePackContent) };
      }
      const s = e as import('../../shared/types').Skill | undefined;
      if (rv.entityType === 'skill' && s) {
        const runs = db.listEvals(org.id, s.id, 50).filter((x) => x.status === 'succeeded');
        const hash = configHash(rv.snapshot as SkillConfig);
        return {
          ...base,
          current: s.published,
          currentVersion: s.publishedVersion,
          evals: { submitted: runs.find((x) => x.configHash === hash && x.split === 'all'), published: runs.find((x) => x.version === s.publishedVersion && x.split === 'all') },
        };
      }
      return { ...base, current: s?.published, currentVersion: s?.publishedVersion };
    }),
  );

  r.post(
    '/:id/decide',
    h((req) => {
      const { user, org } = who(req);
      const b = (req.body ?? {}) as { decision?: string; comment?: unknown; attestation?: Partial<RulePackAttestation> };
      if (b.decision !== 'approved' && b.decision !== 'rejected') throw Errors.badRequest('decision 必须是 approved 或 rejected。');
      if (b.decision === 'rejected' && !text(b.comment, 2000)) throw Errors.badRequest('驳回时请填写意见，方便提交人修改。');
      const a = b.attestation;
      const attestation: RulePackAttestation | undefined = a
        ? { approverName: text(a.approverName, 80), approverQualification: text(a.approverQualification, 200), attested: a.attested === true, reviewDueAt: text(a.reviewDueAt, 40) }
        : undefined;
      return toView(ctx.governance.decide(org, user, param(req, 'id'), b.decision, text(b.comment, 2000), attestation), user, org);
    }),
  );

  r.post(
    '/:id/withdraw',
    h((req) => {
      const { user, org } = who(req);
      return toView(ctx.governance.withdraw(org, user, param(req, 'id')), user, org);
    }),
  );
  return r;
}
