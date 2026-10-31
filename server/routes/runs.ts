import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Org, Run, RunSummary, User } from '../../shared/types';
import type { AppContext } from '../context';
import { requirePermission } from '../core/permissions';
import { renderRunMarkdown } from '../core/report';
import { Errors } from '../errors';
import { can, h, param, text, who } from './util';
import { runForViewer } from './views';

export function toSummary(run: Run): RunSummary {
  const nodes = run.order.map((id) => run.nodes[id]);
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    mode: run.mode,
    status: run.status,
    provider: run.provider,
    startedByName: run.startedByName,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    nodeCount: nodes.length,
    failedNode: nodes.find((n) => n.status === 'failed')?.name,
    waitingNode: nodes.find((n) => n.status === 'waiting_approval')?.name,
    errorCode: run.error?.code,
    costUsd: run.usage.costUsd,
  };
}

export function runsRouter(ctx: AppContext) {
  const r = Router();
  const { db, engine } = ctx;

  /** Runs are visible to their starter, to roles with run.view_all, and to anyone who must approve a node. */
  const visible = (run: Run, user: User, org: Org) =>
    run.startedBy === user.id ||
    can(user, org, 'run.view_all') ||
    Object.values(run.nodes).some((n) => n.status === 'waiting_approval' && n.approvalRequest && (user.role === n.approvalRequest.approverRole || user.role === 'admin'));
  const load = (user: User, org: Org, id: string) => {
    const run = engine.get(org.id, id);
    if (!visible(run, user, org)) throw Errors.notFound('运行记录');
    return run;
  };
  /** Strips prompts / raw model output for roles without run.view_internals (使用者). */
  const out = (user: User, org: Org, run: Run) => runForViewer(run, can(user, org, 'run.view_internals'));

  r.get(
    '/',
    h((req) => {
      const { user, org } = who(req);
      const all = can(user, org, 'run.view_all');
      const workflowId = typeof req.query.workflowId === 'string' ? req.query.workflowId : undefined;
      return db.listRuns(org.id, { workflowId, startedBy: all ? undefined : user.id, limit: 200 }).map((x) => toSummary(engine.get(org.id, x.id)));
    }),
  );

  r.get(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      return out(user, org, load(user, org, param(req, 'id')));
    }),
  );

  /** Server-Sent Events: the bridge that streams node status, agent transcript and approvals to the browser. */
  r.get(
    '/:id/events',
    h((req, res) => {
      const { user, org } = who(req);
      const run = load(user, org, param(req, 'id'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ runId: run.id, status: run.status })}\n\n`);
      const unsubscribe = ctx.events.subscribe(run.id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
    }),
  );

  r.post(
    '/:id/rerun',
    h(async (req, res) => {
      const { user, org } = who(req);
      const prev = load(user, org, param(req, 'id'));
      const wf = db.workflows.get(org.id, prev.workflowId);
      if (!wf) throw Errors.notFound('工作流');
      const override = ((req.body ?? {}) as { inputs?: Record<string, unknown> }).inputs ?? {};
      const inputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(prev.inputs)) inputs[k] = prev.documents[k] ? { documentId: prev.documents[k] } : v;
      Object.assign(inputs, override);
      const run = await engine.start({ org, user, workflow: wf, mode: prev.mode, inputs, fault: prev.faultInjection, rerunOf: prev.id });
      res.status(201);
      return out(user, org, run);
    }),
  );

  /** Retry from the failed node with the same versions; successful nodes are reused. */
  r.post(
    '/:id/retry',
    h(async (req, res) => {
      const { user, org } = who(req);
      const prev = load(user, org, param(req, 'id'));
      const run = await engine.retry({ org, user, runId: prev.id });
      res.status(201);
      return out(user, org, run);
    }),
  );

  r.post(
    '/:id/nodes/:nodeId/decision',
    h(async (req) => {
      const { user, org } = who(req);
      const b = (req.body ?? {}) as { decision?: string; comment?: unknown };
      if (b.decision !== 'approved' && b.decision !== 'rejected') throw Errors.badRequest('decision 必须是 approved 或 rejected。');
      if (b.decision === 'rejected' && !text(b.comment, 2000)) throw Errors.badRequest('驳回时请填写意见。');
      return out(user, org, await engine.decide({ org, user, runId: param(req, 'id'), nodeId: param(req, 'nodeId'), decision: b.decision, comment: text(b.comment, 2000) }));
    }),
  );

  /** Human review marks on individual findings: accept / edit (with corrected fields) / reject, plus a note. */
  r.put(
    '/:id/reviews',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'run.review');
      const run = load(user, org, param(req, 'id'));
      const b = (req.body ?? {}) as { nodeId?: string; location?: string; decision?: string | null; note?: unknown; edits?: unknown };
      const nodeId = text(b.nodeId, 40);
      const location = text(b.location, 120);
      if (!run.nodes[nodeId] || !/^[a-z_][a-z0-9_]*(\[\d+\])?(\.[a-z_][a-z0-9_]*(\[\d+\])?)*$/i.test(location)) throw Errors.badRequest('复核对象无效。');
      const key = `${nodeId}|${location}`;
      let edits: Record<string, string> | undefined;
      if (b.decision === 'edited') {
        const raw = (b.edits && typeof b.edits === 'object' ? b.edits : {}) as Record<string, unknown>;
        edits = Object.fromEntries(
          Object.entries(raw)
            .filter(([k, v]) => /^[a-z_][a-z0-9_]{0,39}$/i.test(k) && typeof v === 'string')
            .slice(0, 20)
            .map(([k, v]) => [k, text(v, 4000)]),
        );
        if (!Object.keys(edits).length) throw Errors.badRequest('“修改后采纳”需要至少修改一个字段。');
      }
      const updated = engine.update(org.id, run.id, (x) => {
        if (b.decision === null || b.decision === undefined || b.decision === '') delete x.reviews[key];
        else if (b.decision === 'accepted' || b.decision === 'rejected' || b.decision === 'edited') {
          x.reviews[key] = { decision: b.decision, note: text(b.note, 1000) || undefined, edits, by: user.id, byName: user.name, at: new Date().toISOString() };
        } else throw Errors.badRequest('decision 必须是 accepted、edited、rejected 或 null。');
      });
      ctx.rt.audit(org.id, user, 'run.review', 'run', run.id, { key, decision: b.decision ?? null, edited: edits ? Object.keys(edits) : undefined });
      return updated.reviews;
    }),
  );

  /** "补充漏项": an issue the reviewer found that the AI missed (counts against H; used by evaluation). */
  r.post(
    '/:id/missed',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'run.review');
      const run = load(user, org, param(req, 'id'));
      const b = (req.body ?? {}) as { nodeId?: unknown; ruleId?: unknown; quote?: unknown; issue?: unknown };
      const nodeId = text(b.nodeId, 40);
      if (!run.nodes[nodeId] || run.nodes[nodeId].type !== 'skill') throw Errors.badRequest('请选择漏项所属的 Skill 节点。');
      const issue = text(b.issue, 2000);
      if (!issue) throw Errors.badRequest('请说明漏掉的问题。');
      const item = { id: `mis_${randomUUID().slice(0, 8)}`, nodeId, ruleId: text(b.ruleId, 40) || 'N/A', quote: text(b.quote, 2000), issue, by: user.id, byName: user.name, at: new Date().toISOString() };
      const updated = engine.update(org.id, run.id, (x) => {
        x.missed = [...(x.missed ?? []), item];
      });
      ctx.rt.audit(org.id, user, 'run.missed_add', 'run', run.id, { id: item.id, nodeId, ruleId: item.ruleId });
      res.status(201);
      return updated.missed;
    }),
  );

  r.delete(
    '/:id/missed/:mid',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'run.review');
      const run = load(user, org, param(req, 'id'));
      const mid = param(req, 'mid');
      if (!(run.missed ?? []).some((m) => m.id === mid)) throw Errors.notFound('漏项记录');
      const updated = engine.update(org.id, run.id, (x) => {
        x.missed = (x.missed ?? []).filter((m) => m.id !== mid);
      });
      ctx.rt.audit(org.id, user, 'run.missed_remove', 'run', run.id, { id: mid });
      return updated.missed;
    }),
  );

  r.get(
    '/:id/export',
    h((req, res) => {
      const { user, org } = who(req);
      const run = load(user, org, param(req, 'id'));
      if (req.query.format === 'json') {
        res.setHeader('Content-Disposition', `attachment; filename="${run.id}.json"`);
        return out(user, org, run);
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${run.id}.md"`);
      res.send(renderRunMarkdown(run));
    }),
  );
  return r;
}
