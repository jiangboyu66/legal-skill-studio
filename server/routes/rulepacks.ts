import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Org, RulePack, RulePackContent } from '../../shared/types';
import type { AppContext } from '../context';
import { requirePermission } from '../core/permissions';
import { assertValidRulePackContent, normalizeRulePackContent } from '../core/rulePacks';
import { Errors } from '../errors';
import { h, param, text, who } from './util';
import { rulePackViews } from './views';

export function rulePacksRouter(ctx: AppContext) {
  const r = Router();
  const { db } = ctx;
  const get = (org: Org, id: string) => {
    const p = db.rulePacks.get(org.id, id);
    if (!p) throw Errors.notFound('规则包');
    return p;
  };
  const view = (org: Org, p: RulePack) => rulePackViews(db, org.id, [p])[0];
  const meta = (b: Record<string, unknown>) => {
    const name = text(b.name, 80);
    if (!name) throw Errors.badRequest('请填写规则包名称。');
    return { name, jurisdiction: text(b.jurisdiction, 40) || 'SG', description: text(b.description, 2000) };
  };

  r.get(
    '/',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'rulepack.view');
      return rulePackViews(db, org.id, db.rulePacks.list(org.id).sort((a, b) => a.name.localeCompare(b.name)));
    }),
  );

  r.post(
    '/',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'rulepack.edit');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const p: RulePack = {
        id: `rp_${randomUUID().slice(0, 8)}`,
        orgId: org.id,
        ...meta(b),
        source: 'user',
        status: 'draft',
        draft: assertValidRulePackContent(b.content ?? { rules: [] }),
        history: [],
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      db.rulePacks.put(p);
      ctx.rt.audit(org.id, user, 'rulepack.create', 'rulepack', p.id, { name: p.name });
      res.status(201);
      return view(org, p);
    }),
  );

  /** Validates content without saving (editor feedback). */
  r.post(
    '/validate',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'rulepack.view');
      return { issues: normalizeRulePackContent((req.body as { content?: unknown })?.content).issues };
    }),
  );

  r.get(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'rulepack.view');
      return view(org, get(org, param(req, 'id')));
    }),
  );

  r.put(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'rulepack.edit');
      const p = get(org, param(req, 'id'));
      if (p.status === 'in_review') throw Errors.conflict('该规则包正在审核中，内容已锁定。', '如需修改，请先在“审核”页撤回申请。');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const next: RulePack = { ...p, ...meta(b), draft: assertValidRulePackContent(b.content), status: p.approvedVersion ? 'approved' : 'draft', updatedAt: new Date().toISOString(), updatedBy: user.id };
      db.rulePacks.put(next);
      ctx.rt.audit(org.id, user, 'rulepack.update', 'rulepack', p.id);
      return view(org, next);
    }),
  );

  r.delete(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'rulepack.edit');
      const p = get(org, param(req, 'id'));
      if (p.status === 'in_review') throw Errors.conflict('该规则包正在审核中，不能删除。');
      const used = view(org, p).usedBy;
      if (used.length) throw Errors.conflict(`该规则包正被 Skill 使用：${used.map((s) => `「${s.name}」`).join('、')}。`, '请先在这些 Skill 中取消关联。');
      db.rulePacks.delete(org.id, p.id);
      ctx.rt.audit(org.id, user, 'rulepack.delete', 'rulepack', p.id, { name: p.name });
      return { ok: true };
    }),
  );

  r.post(
    '/:id/submit',
    h((req) => {
      const { user, org } = who(req);
      return ctx.governance.submit(org, user, 'rulepack', param(req, 'id'), text((req.body as { note?: unknown })?.note, 1000));
    }),
  );

  r.get(
    '/:id/versions/:v',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'rulepack.view');
      const p = get(org, param(req, 'id'));
      const c = db.getVersion<RulePackContent>('rulepack', p.id, Number(param(req, 'v')));
      if (!c) throw Errors.notFound('该版本');
      return c;
    }),
  );
  return r;
}
