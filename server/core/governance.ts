import { randomUUID } from 'node:crypto';
import type { Org, ReviewEntity, ReviewRequest, RulePack, RulePackApproval, RulePackContent, Skill, SkillConfig, User, Workflow, WorkflowDef } from '../../shared/types';
import { AppError, Errors } from '../errors';
import type { Db } from '../services/storage/db';
import { validateWorkflowDef } from './workflow/dag';
import { requirePermission } from './permissions';

const LABEL: Record<ReviewEntity, string> = { skill: 'Skill', workflow: '工作流', rulepack: '规则包' };

export interface RulePackAttestation {
  approverName: string;
  approverQualification: string;
  attested: boolean;
  reviewDueAt: string;
}

/**
 * Publish approval ("draft → in review → published / approved").
 * Builders submit; reviewers approve; with requireDistinctApprover the submitter cannot approve.
 * Approval publishes exactly the submitted snapshot as a new immutable version.
 */
export class Governance {
  constructor(private db: Db, private audit: (orgId: string, user: Pick<User, 'id' | 'name'>, action: string, type: string, id: string, detail?: unknown) => void) {}

  private entity(org: Org, type: ReviewEntity, id: string): Skill | Workflow | RulePack {
    const e = type === 'skill' ? this.db.skills.get(org.id, id) : type === 'workflow' ? this.db.workflows.get(org.id, id) : this.db.rulePacks.get(org.id, id);
    if (!e) throw Errors.notFound(LABEL[type]);
    return e;
  }

  private put(type: ReviewEntity, e: Skill | Workflow | RulePack) {
    if (type === 'skill') this.db.skills.put(e as Skill);
    else if (type === 'workflow') this.db.workflows.put(e as Workflow);
    else this.db.rulePacks.put(e as RulePack);
  }

  /** skillId → latest published version, for every skill node of a workflow definition. */
  currentPins(org: Org, def: WorkflowDef): Record<string, number> {
    const pins: Record<string, number> = {};
    for (const n of def.nodes) {
      if (n.type !== 'skill') continue;
      const v = this.db.skills.get(org.id, n.skillId)?.publishedVersion;
      if (v) pins[n.skillId] = v;
    }
    return pins;
  }

  pendingFor(org: Org, type: ReviewEntity, id: string) {
    return this.db.reviews.list(org.id).find((r) => r.entityType === type && r.entityId === id && r.status === 'pending');
  }

  submit(org: Org, user: User, type: ReviewEntity, id: string, note?: string): ReviewRequest {
    requirePermission(user, org, `${type}.submit`);
    const e = this.entity(org, type, id);
    if (this.pendingFor(org, type, id)) throw Errors.conflict(`该${LABEL[type]}已有待处理的审核申请。`, '请等待审核人处理，或先撤回原申请。');
    if (type === 'workflow') {
      const wf = e as Workflow;
      const issues = validateWorkflowDef(wf.draft, (sid) => {
        const s = this.db.skills.get(org.id, sid);
        return s ? { name: s.name, config: s.published ?? s.draft } : undefined;
      }).filter((i) => i.level === 'error');
      if (issues.length) throw Errors.workflowInvalid(issues);
    }
    if (type === 'rulepack' && !(e as RulePack).draft.rules.length) throw Errors.badRequest('规则包至少需要一条规则。');
    const snapshot = structuredClone(e.draft) as SkillConfig | WorkflowDef | RulePackContent;
    if (type === 'workflow') {
      // Pin the skill versions the reviewer is approving (filled in at approval for skills published later).
      const def = snapshot as WorkflowDef;
      def.pins = this.currentPins(org, def);
    }
    const req: ReviewRequest = {
      id: `rev_${randomUUID().slice(0, 8)}`,
      orgId: org.id,
      entityType: type,
      entityId: id,
      entityName: e.name,
      status: 'pending',
      submittedBy: user.id,
      submittedByName: user.name,
      note: note?.trim() || undefined,
      snapshot,
      createdAt: new Date().toISOString(),
    };
    this.db.tx(() => {
      this.db.reviews.put(req);
      this.put(type, { ...e, status: 'in_review', updatedAt: req.createdAt } as never);
    });
    this.audit(org.id, user, `${type}.submit`, type, id, { request: req.id, note: req.note });
    return req;
  }

  withdraw(org: Org, user: User, requestId: string): ReviewRequest {
    const req = this.db.reviews.get(org.id, requestId);
    if (!req || req.status !== 'pending') throw Errors.notFound('待处理的审核申请');
    if (req.submittedBy !== user.id && user.role !== 'admin') throw Errors.forbidden('撤回他人的审核申请');
    const e = this.entity(org, req.entityType, req.entityId);
    const done = { ...req, status: 'withdrawn' as const, decidedAt: new Date().toISOString(), decidedBy: user.id, decidedByName: user.name };
    this.db.tx(() => {
      this.db.reviews.put(done);
      this.put(req.entityType, { ...e, status: this.restingStatus(e) } as never);
    });
    return done;
  }

  private restingStatus(e: Skill | Workflow | RulePack): never {
    if ('approvedVersion' in e) return (e.approvedVersion ? 'approved' : 'draft') as never;
    return ((e as Skill).publishedVersion ? 'published' : 'draft') as never;
  }

  decide(org: Org, user: User, requestId: string, decision: 'approved' | 'rejected', comment?: string, attestation?: RulePackAttestation): ReviewRequest {
    const req = this.db.reviews.get(org.id, requestId);
    if (!req || req.status !== 'pending') throw Errors.notFound('待处理的审核申请');
    requirePermission(user, org, `${req.entityType}.approve`);
    if (org.policy.requireDistinctApprover && req.submittedBy === user.id) {
      throw Errors.forbidden('审批自己提交的申请', '组织策略要求“四眼原则”：提交人不能批准自己的申请，请由其他审核人处理。');
    }
    const e = this.entity(org, req.entityType, req.entityId);
    const ts = new Date().toISOString();
    const done: ReviewRequest = { ...req, status: decision, decidedBy: user.id, decidedByName: user.name, comment: comment?.trim() || undefined, decidedAt: ts };
    if (decision === 'rejected') {
      this.db.tx(() => {
        this.db.reviews.put(done);
        this.put(req.entityType, { ...e, status: this.restingStatus(e) } as never);
      });
      this.audit(org.id, user, `${req.entityType}.reject`, req.entityType, req.entityId, { request: req.id, comment: done.comment });
      return done;
    }

    if (req.entityType === 'rulepack') {
      const a = attestation;
      if (!a || !a.approverName?.trim() || !a.approverQualification?.trim() || !a.attested) {
        throw new AppError('ATTESTATION_REQUIRED', '批准规则包需要填写审核人姓名、执业资格，并确认已逐条核对。', { status: 400, hint: '审核声明会随规则包版本永久保存，并显示在使用该规则包的每次运行中。' });
      }
      const due = new Date(a.reviewDueAt);
      const months = (due.getTime() - Date.now()) / (30 * 86400_000);
      if (Number.isNaN(due.getTime()) || months < 0.5 || months > 24) throw Errors.badRequest('复审截止日期需在半个月到 24 个月之间。');
      const rp = e as RulePack;
      const version = (rp.approvedVersion ?? 0) + 1;
      const approval: RulePackApproval = {
        version,
        approvedBy: user.id,
        approverName: a.approverName.trim(),
        approverQualification: a.approverQualification.trim(),
        attestation: '本人已逐条核对规则内容、来源及适用范围，确认可用于本组织的营销物料初审。',
        approvedAt: ts,
        reviewDueAt: due.toISOString(),
        comment: done.comment,
      };
      const content = req.snapshot as RulePackContent;
      this.db.tx(() => {
        this.db.reviews.put(done);
        this.db.rulePacks.put({ ...rp, status: 'approved', approvedVersion: version, approved: content, approval, history: [...rp.history, approval], updatedAt: ts });
        this.db.putVersion('rulepack', rp.id, version, content);
      });
      this.audit(org.id, user, 'rulepack.approve', 'rulepack', rp.id, { version, approver: approval.approverName, qualification: approval.approverQualification, reviewDueAt: approval.reviewDueAt });
      return done;
    }

    const prev = e as Skill | Workflow;
    const version = (prev.publishedVersion ?? 0) + 1;
    const snapshot = req.snapshot as SkillConfig | WorkflowDef;
    if (req.entityType === 'workflow') {
      const unpublished = (snapshot as WorkflowDef).nodes
        .filter((n) => n.type === 'skill')
        .map((n) => this.db.skills.get(org.id, (n as { skillId: string }).skillId))
        .filter((s) => !s?.published);
      if (unpublished.length) {
        throw Errors.conflict(`工作流引用的 Skill 尚未发布：${unpublished.map((s) => `「${s?.name ?? '已删除'}」`).join('、')}。`, '请先批准这些 Skill 的发布申请。');
      }
      const def = snapshot as WorkflowDef;
      def.pins = { ...this.currentPins(org, def), ...(def.pins ?? {}) };
    }
    const info = { version, approvedBy: user.id, approvedByName: user.name, submittedBy: req.submittedBy, approvedAt: ts, changelog: req.note };
    this.db.tx(() => {
      this.db.reviews.put(done);
      this.put(req.entityType, { ...prev, status: 'published', published: snapshot, publishedVersion: version, versions: [...prev.versions, info], updatedAt: ts } as never);
      this.db.putVersion(req.entityType, prev.id, version, snapshot);
    });
    this.audit(org.id, user, `${req.entityType}.publish`, req.entityType, prev.id, { version, request: req.id });
    return done;
  }
}
