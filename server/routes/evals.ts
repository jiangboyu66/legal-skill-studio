import { Router } from 'express';
import type { EvalRun, SkillEvalsView } from '../../shared/types';
import type { AppContext } from '../context';
import { configHash, evalSetFor, evalSetInfo } from '../core/eval';
import { Errors } from '../errors';
import { h, param, requireAny, text, who } from './util';
import { skillViews } from './views';

/** Evaluation and optimisation endpoints (mounted under /api). */
export function evalsRouter(ctx: AppContext) {
  const r = Router();
  const { db } = ctx;
  const skillOf = (orgId: string, id: string) => {
    const s = db.skills.get(orgId, id);
    if (!s) throw Errors.notFound('Skill');
    return s;
  };

  r.get(
    '/skills/:id/evals',
    h((req): SkillEvalsView => {
      const { user, org } = who(req);
      requireAny(user, org, ['skill.edit', 'skill.approve'], '查看评测');
      const s = skillOf(org.id, param(req, 'id'));
      const set = evalSetFor(s.draft) ?? (s.published ? evalSetFor(s.published) : undefined);
      return {
        set: set ? evalSetInfo(set) : undefined,
        notApplicable: set ? undefined : '没有适用于该 Skill 输出结构的评测集（需要 findings 列表，含 rule_id 与 quote 字段，并在“结论核验”中配置）。',
        draftHash: configHash(s.draft),
        runs: db.listEvals(org.id, s.id, 20),
        optimizations: db.listOptimizations(org.id, s.id, 10),
      };
    }),
  );

  r.post(
    '/skills/:id/evals',
    h((req, res) => {
      const { user, org } = who(req);
      requireAny(user, org, ['skill.edit', 'skill.approve'], '运行评测');
      const s = skillOf(org.id, param(req, 'id'));
      const b = (req.body ?? {}) as { target?: string; split?: string };
      const split = (['all', 'train', 'holdout'].includes(String(b.split)) ? b.split : 'all') as EvalRun['split'];
      const run = ctx.evals.start({ org, user, skill: s, target: b.target === 'published' ? 'published' : 'draft', split });
      res.status(202);
      return run;
    }),
  );

  r.get(
    '/evals/:id',
    h((req) => {
      const { user, org } = who(req);
      requireAny(user, org, ['skill.edit', 'skill.approve'], '查看评测');
      const e = db.evals.get(org.id, param(req, 'id'));
      if (!e) throw Errors.notFound('评测记录');
      return e;
    }),
  );

  r.post(
    '/skills/:id/optimizations',
    h((req, res) => {
      const { user, org } = who(req);
      const s = skillOf(org.id, param(req, 'id'));
      const opt = ctx.evals.optimize({ org, user, skill: s, baselineEvalId: text((req.body as { baselineEvalId?: unknown })?.baselineEvalId, 40) });
      res.status(202);
      return opt;
    }),
  );

  r.get(
    '/optimizations/:id',
    h((req) => {
      const { user, org } = who(req);
      requireAny(user, org, ['skill.edit', 'skill.approve'], '查看优化记录');
      const o = db.optimizations.get(org.id, param(req, 'id'));
      if (!o) throw Errors.notFound('优化记录');
      return o;
    }),
  );

  r.post(
    '/skills/:id/optimizations/:oid/adopt',
    h((req) => {
      const { user, org } = who(req);
      const s = skillOf(org.id, param(req, 'id'));
      const next = ctx.evals.adopt({ org, user, skill: s, optimizationId: param(req, 'oid') });
      return skillViews(db, org.id, [next])[0];
    }),
  );
  return r;
}
