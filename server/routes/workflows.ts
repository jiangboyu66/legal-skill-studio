import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { FaultInjection, FaultType, Org, User, Workflow, WorkflowDef, WorkflowView } from '../../shared/types';
import type { AppContext } from '../context';
import { requirePermission } from '../core/permissions';
import { validateWorkflowDef } from '../core/workflow/dag';
import { normalizeWorkflowDef } from '../core/workflow/normalize';
import { Errors } from '../errors';
import { can, consumerOnly, h, param, requireAny, text, who } from './util';
import { consumerWorkflowView, runForViewer, workflowViews } from './views';

const FAULTS: FaultType[] = ['none', 'auth', 'rate_limit', 'timeout', 'server_error', 'bad_output', 'bad_output_once'];

export function workflowsRouter(ctx: AppContext) {
  const r = Router();
  const { db } = ctx;
  const get = (org: Org, id: string) => {
    const w = db.workflows.get(org.id, id);
    if (!w) throw Errors.notFound('工作流');
    return w;
  };
  const view = (org: Org, w: Workflow) => workflowViews(db, org.id, [w])[0];
  /** 使用者 only see published workflows (the published definition, no draft). */
  const viewFor = (user: User, org: Org, w: Workflow) => {
    const v = view(org, w);
    if (!consumerOnly(user, org, 'workflow')) return v;
    const c = consumerWorkflowView(v);
    if (!c) throw Errors.notFound('工作流');
    return c;
  };
  const meta = (b: Record<string, unknown>) => {
    const name = text(b.name, 80);
    if (!name) throw Errors.badRequest('请填写工作流名称。');
    return { name, description: text(b.description, 1000) };
  };
  const def = (org: Org, raw: unknown): WorkflowDef => {
    const d = normalizeWorkflowDef(raw);
    for (const n of d.nodes) {
      if (n.type === 'skill' && n.skillId && !db.skills.get(org.id, n.skillId)) throw Errors.badRequest(`节点「${n.name}」引用的 Skill 不存在。`);
    }
    return d;
  };

  r.get(
    '/',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.view');
      const views = workflowViews(db, org.id, db.workflows.list(org.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      if (!consumerOnly(user, org, 'workflow')) return views;
      return views.map(consumerWorkflowView).filter((v): v is WorkflowView => !!v);
    }),
  );

  r.post(
    '/',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.edit');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const ts = new Date().toISOString();
      const w: Workflow = {
        id: `wf_${randomUUID().slice(0, 8)}`,
        orgId: org.id,
        ...meta(b),
        source: 'user',
        status: 'draft',
        draft: def(org, b.def ?? { inputs: [], nodes: [] }),
        versions: [],
        createdBy: user.id,
        updatedBy: user.id,
        createdAt: ts,
        updatedAt: ts,
      };
      db.workflows.put(w);
      ctx.rt.audit(org.id, user, 'workflow.create', 'workflow', w.id, { name: w.name });
      res.status(201);
      return view(org, w);
    }),
  );

  /** Live validation for the editor (same checks as save / submit / run). */
  r.post(
    '/validate',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.view');
      const d = normalizeWorkflowDef((req.body as { def?: unknown })?.def);
      return {
        issues: validateWorkflowDef(d, (id) => {
          const s = db.skills.get(org.id, id);
          return s ? { name: s.name, config: s.draft } : undefined;
        }),
      };
    }),
  );

  r.get(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.view');
      return viewFor(user, org, get(org, param(req, 'id')));
    }),
  );

  r.put(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.edit');
      const w = get(org, param(req, 'id'));
      if (w.status === 'in_review') throw Errors.conflict('该工作流正在审核中，内容已锁定。', '如需修改，请先在“审核”页撤回发布申请。');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const next: Workflow = { ...w, ...meta(b), draft: def(org, b.def), status: w.publishedVersion ? 'published' : 'draft', updatedBy: user.id, updatedAt: new Date().toISOString() };
      db.workflows.put(next);
      ctx.rt.audit(org.id, user, 'workflow.update', 'workflow', w.id);
      return view(org, next);
    }),
  );

  r.delete(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.delete');
      const w = get(org, param(req, 'id'));
      if (w.status === 'in_review') throw Errors.conflict('该工作流正在审核中，不能删除。');
      db.workflows.delete(org.id, w.id);
      ctx.rt.audit(org.id, user, 'workflow.delete', 'workflow', w.id, { name: w.name });
      return { ok: true };
    }),
  );

  r.post(
    '/:id/duplicate',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.edit');
      const src = get(org, param(req, 'id'));
      const ts = new Date().toISOString();
      const w: Workflow = {
        ...structuredClone(src),
        id: `wf_${randomUUID().slice(0, 8)}`,
        name: `${src.name}（副本）`.slice(0, 80),
        source: 'user',
        status: 'draft',
        published: undefined,
        publishedVersion: undefined,
        versions: [],
        createdBy: user.id,
        updatedBy: user.id,
        createdAt: ts,
        updatedAt: ts,
      };
      db.workflows.put(w);
      res.status(201);
      return view(org, w);
    }),
  );

  r.post(
    '/:id/submit',
    h((req) => {
      const { user, org } = who(req);
      return ctx.governance.submit(org, user, 'workflow', param(req, 'id'), text((req.body as { note?: unknown })?.note, 1000));
    }),
  );

  r.get(
    '/:id/versions/:v',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'workflow.view');
      requireAny(user, org, ['workflow.edit', 'workflow.approve'], '查看工作流历史版本');
      const w = get(org, param(req, 'id'));
      const d = db.getVersion<WorkflowDef>('workflow', w.id, Number(param(req, 'v')));
      if (!d) throw Errors.notFound('该版本');
      return d;
    }),
  );

  /** Start a run: mode "production" uses the published version, "test" the draft (with optional fault injection). */
  r.post(
    '/:id/runs',
    h(async (req, res) => {
      const { user, org } = who(req);
      const w = get(org, param(req, 'id'));
      const b = (req.body ?? {}) as { mode?: string; inputs?: Record<string, unknown>; fault?: FaultInjection; options?: { showThinking?: unknown } };
      const fault = b.fault && FAULTS.includes(b.fault.type) ? { type: b.fault.type, nodeId: text(b.fault.nodeId, 40) || undefined } : undefined;
      // "深度思考" (show the model's reasoning) is for roles that may see run internals
      const options = b.options?.showThinking === true && can(user, org, 'run.view_internals') ? { showThinking: true } : undefined;
      const run = await ctx.engine.start({ org, user, workflow: w, mode: b.mode === 'test' ? 'test' : 'production', inputs: b.inputs ?? {}, fault, options });
      res.status(201);
      return runForViewer(run, can(user, org, 'run.view_internals'));
    }),
  );
  return r;
}
