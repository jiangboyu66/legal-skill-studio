import { randomUUID } from 'node:crypto';
import { getAtPath, ROLE_LABEL } from '../../../shared/schema';
import type {
  ApprovalNode,
  FaultInjection,
  Mapping,
  MaterialDocument,
  NodeRun,
  NodeStatus,
  Org,
  RulePack,
  RulePackContent,
  RulePackSnapshot,
  Run,
  RunEvent,
  RunStatus,
  RunWarning,
  SkillConfig,
  SkillNode,
  Usage,
  User,
  Workflow,
} from '../../../shared/types';
import { AppError, Errors, toErrorInfo } from '../../errors';
import type { DocumentService } from '../../services/documents';
import { resolveJurisdiction } from '../jurisdiction';
import { decide, requirePermission } from '../permissions';
import type { Runtime } from '../runtime';
import { executeSkill } from '../skills';
import { topoOrder, validateWorkflowDef } from './dag';
import { evaluate } from './expr';

const now = () => new Date().toISOString();
const FINISHED_NODE: NodeStatus[] = ['succeeded', 'skipped', 'rejected'];
const TERMINAL_RUN: RunStatus[] = ['succeeded', 'failed', 'rejected'];

export function rulePackStatus(rp: RulePack): RulePack['status'] {
  if (rp.approval && new Date(rp.approval.reviewDueAt).getTime() < Date.now()) return 'expired';
  return rp.status;
}

function addUsage(a: Usage, b?: Usage): Usage {
  if (!b) return a;
  const s = (x?: number, y?: number) => (x ?? 0) + (y ?? 0) || undefined;
  return {
    inputTokens: s(a.inputTokens, b.inputTokens),
    outputTokens: s(a.outputTokens, b.outputTokens),
    cacheReadTokens: s(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: s(a.cacheWriteTokens, b.cacheWriteTokens),
    costUsd: a.costUsd !== undefined || b.costUsd !== undefined ? (a.costUsd ?? 0) + (b.costUsd ?? 0) : undefined,
  };
}

const toText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/**
 * Workflow orchestrator (coordinator over skill sub-agents): a DAG of skill and approval nodes.
 *  - a node starts when all `needs` are finished (succeeded / skipped / rejected-with-continue)
 *  - `when` conditions create branches; independent nodes run in parallel (bounded concurrency)
 *  - approval nodes and "ask" tool permissions pause the run until an authorised person decides
 *  - every state change is persisted and published as a run event; runs resume after a restart
 */
export class WorkflowEngine {
  private live = new Map<string, Run>();
  private running = new Map<string, number>();
  private pending = new Set<Promise<void>>();
  private docCache = new Map<string, MaterialDocument>();

  constructor(private rt: Runtime, private docs: DocumentService) {}

  // ───────────── public API ─────────────

  async start(p: { org: Org; user: User; workflow: Workflow; mode: 'production' | 'test'; inputs: Record<string, unknown>; fault?: FaultInjection; rerunOf?: string }): Promise<Run> {
    const { org, user, workflow: wf, mode } = p;
    requirePermission(user, org, mode === 'production' ? 'workflow.run' : 'workflow.test');
    const def = mode === 'production' ? wf.published : wf.draft;
    if (!def) {
      throw new AppError('WORKFLOW_NOT_PUBLISHED', `工作流「${wf.name}」尚未发布，不能正式运行。`, { status: 409, hint: '请先提交发布并由审核人批准；创建者可以使用“测试运行”验证草稿。' });
    }

    const warnings: RunWarning[] = [];
    const skills: Run['skills'] = {};
    for (const n of def.nodes) {
      if (n.type !== 'skill' || skills[n.skillId]) continue;
      const s = this.rt.db.skills.get(org.id, n.skillId);
      if (!s) throw Errors.notFound(`节点「${n.name}」使用的 Skill`);
      if (mode === 'production') {
        const pin = def.pins?.[s.id];
        if (pin) {
          // Approved workflow versions run exactly the skill versions that were approved with them.
          const cfg = this.rt.db.getVersion<SkillConfig>('skill', s.id, pin);
          if (!cfg) throw new AppError('SKILL_VERSION_MISSING', `工作流钉住的 Skill「${s.name}」v${pin} 不存在。`, { status: 409, hint: '请重新提交工作流审批以钉住现有版本。' });
          skills[s.id] = { name: s.name, version: pin, config: cfg };
          if (s.publishedVersion && s.publishedVersion > pin) {
            warnings.push({ code: 'SKILL_UPDATE_AVAILABLE', message: `Skill「${s.name}」已发布 v${s.publishedVersion}，本工作流仍按审批时钉住的 v${pin} 运行；如需升级，请重新提交工作流审批。` });
          }
          continue;
        }
        if (!s.published || !s.publishedVersion) {
          throw new AppError('SKILL_NOT_PUBLISHED', `Skill「${s.name}」尚未发布，不能用于正式运行。`, { status: 409, hint: '请先提交该 Skill 的发布申请并由审核人批准。' });
        }
        skills[s.id] = { name: s.name, version: s.publishedVersion, config: s.published };
        warnings.push({ code: 'SKILL_NOT_PINNED', message: `该工作流版本未钉住 Skill 版本，「${s.name}」使用最新发布的 v${s.publishedVersion}。重新提交审批后将钉住版本。` });
      } else skills[s.id] = { name: s.name, version: 'draft', config: s.draft };
    }
    const issues = validateWorkflowDef(def, (id) => skills[id]).filter((i) => i.level === 'error');
    if (issues.length) throw Errors.workflowInvalid(issues);

    // Rule packs: production runs need approved, unexpired versions (org policy).
    const packJurisdictions: string[] = [];
    const rulePacks: RulePackSnapshot[] = [];
    const rulePackContents: Record<string, RulePackContent> = {};
    const packIds = [...new Set(Object.values(skills).flatMap((s) => s.config.rulePackIds))];
    for (const id of packIds) {
      const rp = this.rt.db.rulePacks.get(org.id, id);
      if (!rp) throw Errors.notFound('Skill 关联的规则包');
      packJurisdictions.push(rp.jurisdiction);
      const status = rulePackStatus(rp);
      if (mode === 'production' && rp.approved && rp.approvedVersion) {
        if (status === 'expired') {
          const msg = `规则包「${rp.name}」的审核已过期（复审截止 ${rp.approval!.reviewDueAt.slice(0, 10)}）。`;
          if (org.policy.requireApprovedRulePacks) throw new AppError('RULEPACK_EXPIRED', msg, { status: 409, hint: '请由法律审核人复审并重新批准规则包。' });
          warnings.push({ code: 'RULEPACK_EXPIRED', message: msg });
        }
        rulePacks.push({ id, name: rp.name, version: rp.approvedVersion, status, approval: rp.approval });
        rulePackContents[id] = rp.approved;
      } else {
        if (mode === 'production' && org.policy.requireApprovedRulePacks) {
          throw new AppError('RULEPACK_NOT_APPROVED', `规则包「${rp.name}」尚未经法律审核批准（当前状态：${{ draft: '草稿', in_review: '待审核', approved: '已批准', expired: '已过期' }[status]}）。`, {
            status: 409,
            hint: '请由具备审核权限的法律人员在“规则包”页面完成审核；或由管理员调整组织策略。',
          });
        }
        warnings.push({ code: 'RULEPACK_UNREVIEWED', message: `规则包「${rp.name}」使用未经审核的草稿内容，结果仅供测试。` });
        rulePacks.push({ id, name: rp.name, version: 'draft', status });
        rulePackContents[id] = rp.draft;
      }
    }

    // Inputs: document inputs accept an uploaded document id or pasted text (stored as a text document).
    const inputs: Record<string, string> = {};
    const documents: Record<string, string> = {};
    const missing: { key: string; label: string }[] = [];
    for (const d of def.inputs) {
      const v = p.inputs?.[d.key];
      if (d.type === 'document') {
        const docId = typeof v === 'object' && v ? String((v as { documentId?: string }).documentId ?? '') : typeof v === 'string' && /^doc_[\w-]+$/.test(v.trim()) ? v.trim() : '';
        if (docId) {
          const doc = this.rt.db.documents.get(org.id, docId);
          if (!doc) throw Errors.badRequest(`输入「${d.label}」引用的文档不存在。`, '请重新上传文件。');
          documents[d.key] = doc.id;
          inputs[d.key] = `[文档] ${doc.filename}`;
        } else if (typeof v === 'string' && v.trim()) {
          const doc = await this.docs.ingestText(v, d.key, org.id, user);
          documents[d.key] = doc.id;
          inputs[d.key] = v;
        } else if (d.required) missing.push({ key: d.key, label: d.label });
        continue;
      }
      let s = typeof v === 'string' ? v : v == null ? '' : String(v);
      if (!s.trim() && d.defaultValue) s = d.defaultValue;
      if (d.required && !s.trim()) missing.push({ key: d.key, label: d.label });
      inputs[d.key] = s;
    }
    if (missing.length) throw Errors.missingInputs(missing);
    const jr = resolveJurisdiction(inputs.jurisdiction, packJurisdictions);
    if (jr.warning) warnings.push(jr.warning);

    const order = topoOrder(def.nodes)!;
    const run: Run = {
      id: `run_${randomUUID().slice(0, 8)}`,
      orgId: org.id,
      workflowId: wf.id,
      workflowName: wf.name,
      workflowVersion: mode === 'production' ? wf.publishedVersion! : 'draft',
      mode,
      status: 'queued',
      startedBy: user.id,
      startedByName: user.name,
      inputs,
      documents,
      provider: this.rt.provider.info,
      faultInjection: p.fault && p.fault.type !== 'none' && mode === 'test' ? p.fault : undefined,
      definition: def,
      skills,
      rulePacks,
      rulePackContents,
      nodes: Object.fromEntries(
        def.nodes.map((n) => {
          const nr: NodeRun = { nodeId: n.id, type: n.type, name: n.name, status: 'pending' };
          if (n.type === 'skill') {
            const s = skills[n.skillId];
            Object.assign(nr, { skillId: n.skillId, skillName: s.name, skillVersion: s.version, outputFormat: s.config.output.format, outputFields: s.config.output.fields });
          }
          return [n.id, nr];
        }),
      ),
      order,
      jurisdiction: jr.jurisdiction,
      reviews: {},
      missed: [],
      warnings,
      grantedTools: [],
      usage: {},
      rerunOf: p.rerunOf,
      createdAt: now(),
    };
    if (p.fault && p.fault.type !== 'none' && mode !== 'test') warnings.push({ code: 'FAULT_IGNORED', message: '故障注入仅在测试运行中生效，已忽略。' });

    // Text inputs plus extracted document text (pasted material is stored as a document — count it once).
    const texts = [...Object.entries(inputs).filter(([k]) => !documents[k]).map(([, v]) => v), ...Object.values(documents).map((id) => this.doc(org.id, id)?.pages.map((x) => x.text).join('\n') ?? '')];
    const outcome = await this.rt.hooks.run('RunStart', { run, texts });
    run.warnings.push(...(outcome.warnings ?? []));
    this.live.set(run.id, run);
    this.save(run);
    this.track(this.schedule(run.id));
    return run;
  }

  /** Decision on an approval node, or on a tool permission request ("ask"). */
  async decide(p: { org: Org; user: User; runId: string; nodeId: string; decision: 'approved' | 'rejected'; comment?: string }): Promise<Run> {
    const run = this.load(p.org.id, p.runId);
    const nr = run.nodes[p.nodeId];
    if (!nr || nr.status !== 'waiting_approval' || !nr.approvalRequest) throw Errors.conflict('该节点当前不需要审批。');
    requirePermission(p.user, p.org, 'run.approve_node');
    const req = nr.approvalRequest;
    if (p.user.role !== 'admin' && p.user.role !== req.approverRole) {
      throw Errors.forbidden(`审批该节点（需要「${ROLE_LABEL[req.approverRole]}」角色）`);
    }
    if (p.org.policy.requireDistinctApprover && run.startedBy === p.user.id) {
      throw Errors.forbidden('审批自己发起的运行', '组织策略要求“四眼原则”：发起人不能审批自己的运行，请由其他审核人处理。');
    }
    const rec = { decision: p.decision, comment: p.comment?.trim() || undefined, byUserId: p.user.id, byName: p.user.name, at: now() };
    if (req.tool) {
      nr.approval = rec;
      if (p.decision === 'approved') {
        run.grantedTools.push(req.tool);
        nr.status = 'pending';
        nr.approvalRequest = undefined;
      } else {
        nr.status = 'failed';
        nr.error = { code: 'PERMISSION_DENIED', message: `工具「${req.tool}」的使用申请被 ${p.user.name} 拒绝。` };
        run.error = { code: 'PERMISSION_DENIED', message: `节点「${nr.name}」失败：${nr.error.message}` };
      }
    } else {
      nr.approval = rec;
      nr.output = { decision: p.decision, comment: rec.comment ?? '', by: p.user.name, at: rec.at };
      nr.finishedAt = rec.at;
      nr.status = p.decision === 'approved' ? 'succeeded' : 'rejected';
      const node = run.definition.nodes.find((n) => n.id === p.nodeId) as ApprovalNode;
      if (p.decision === 'rejected' && node.onReject === 'stop') {
        for (const other of Object.values(run.nodes)) {
          if (other.status === 'pending') Object.assign(other, { status: 'skipped', skipReason: `「${nr.name}」被驳回` });
        }
      }
    }
    this.rt.audit(p.org.id, p.user, req.tool ? `run.tool_${p.decision}` : `run.approval_${p.decision}`, 'run', run.id, { nodeId: p.nodeId, comment: rec.comment });
    this.emit({ type: 'approval_decided', runId: run.id, nodeId: p.nodeId, decision: p.decision });
    this.emit({ type: 'node_status', runId: run.id, nodeId: p.nodeId, status: nr.status });
    if (run.status === 'waiting_approval') {
      run.status = 'running';
      this.emit({ type: 'run_status', runId: run.id, status: 'running' });
    }
    this.save(run);
    await this.schedule(run.id);
    return run;
  }

  /**
   * Retry a failed run from the failed node: same workflow / skill / rule-pack snapshots and inputs,
   * successful nodes (and granted approvals) are reused, everything else runs again. Fault injection
   * is dropped — a retry is for transient failures such as rate limits or timeouts.
   */
  async retry(p: { org: Org; user: User; runId: string }): Promise<Run> {
    const { org, user } = p;
    const prev = this.get(org.id, p.runId);
    if (prev.status !== 'failed') throw Errors.conflict('只有失败的运行可以从失败节点重试。', '已完成或被驳回的运行请使用“重新运行”（按当前配置全部重跑）。');
    requirePermission(user, org, prev.mode === 'production' ? 'workflow.run' : 'workflow.test');
    if (prev.mode === 'production' && org.policy.requireApprovedRulePacks) {
      const expired = prev.rulePacks.find((rp) => rp.approval && new Date(rp.approval.reviewDueAt).getTime() < Date.now());
      if (expired) throw new AppError('RULEPACK_EXPIRED', `规则包「${expired.name}」的审核已过期，不能沿用原运行的版本重试。`, { status: 409, hint: '请复审规则包后使用“重新运行”。' });
    }
    const reused = Object.values(prev.nodes).filter((n) => n.status === 'succeeded');
    const dropped = new Set(['RESUMED', 'FAULT_IGNORED', 'FAULT_INJECTED', 'RETRY']);
    const run: Run = {
      ...structuredClone(prev),
      id: `run_${randomUUID().slice(0, 8)}`,
      status: 'queued',
      startedBy: user.id,
      startedByName: user.name,
      faultInjection: undefined,
      finalOutput: undefined,
      finalFormat: undefined,
      finalNodeId: undefined,
      reviews: {},
      missed: [],
      usage: {},
      error: undefined,
      rerunOf: undefined,
      retryOf: prev.id,
      createdAt: now(),
      startedAt: undefined,
      finishedAt: undefined,
      warnings: [
        {
          code: 'RETRY',
          message: `从失败节点重试（原运行 ${prev.id}）：沿用原运行的工作流、Skill 与规则包版本，复用 ${reused.length} 个已成功节点的结果${prev.faultInjection ? '；不再注入故障' : ''}。`,
        },
        ...prev.warnings.filter((w) => !dropped.has(w.code)),
      ],
    };
    for (const [id, n] of Object.entries(run.nodes)) {
      if (n.status === 'succeeded') {
        n.reusedFrom = n.reusedFrom ?? prev.id;
        continue;
      }
      run.nodes[id] = {
        nodeId: n.nodeId, type: n.type, name: n.name, status: 'pending',
        skillId: n.skillId, skillName: n.skillName, skillVersion: n.skillVersion, outputFormat: n.outputFormat, outputFields: n.outputFields,
      };
    }
    this.rt.audit(org.id, user, 'run.retry', 'run', run.id, { retryOf: prev.id, reused: reused.map((n) => n.nodeId) });
    this.live.set(run.id, run);
    this.save(run);
    this.track(this.schedule(run.id));
    return run;
  }

  /** Re-attach runs left unfinished by a previous process; interrupted nodes are re-executed. */
  resumeAll() {
    for (const run of this.rt.db.runsByStatus(['queued', 'running'])) {
      for (const nr of Object.values(run.nodes)) if (nr.status === 'running') nr.status = 'pending';
      run.warnings.push({ code: 'RESUMED', message: '服务重启后已自动恢复执行（中断的节点已重新运行）。' });
      this.live.set(run.id, run);
      this.save(run);
      this.track(this.schedule(run.id));
    }
  }

  /** Resolves when no node is executing (tests, graceful shutdown). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ───────────── scheduling ─────────────

  private track(p: Promise<void>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  /** Current state of a run (the live copy while it is executing). */
  get(orgId: string, runId: string): Run {
    const r = this.live.get(runId) ?? this.rt.db.runs.get(orgId, runId);
    if (!r || r.orgId !== orgId) throw Errors.notFound('运行记录');
    return r;
  }

  /** Applies a change (e.g. human review marks) through the engine, so a live copy cannot overwrite it later. */
  update(orgId: string, runId: string, fn: (run: Run) => void): Run {
    const run = this.get(orgId, runId);
    fn(run);
    this.save(run);
    return run;
  }

  private load(orgId: string, runId: string): Run {
    const r = this.get(orgId, runId);
    if (!TERMINAL_RUN.includes(r.status)) this.live.set(r.id, r);
    return r;
  }

  private save(run: Run) {
    this.rt.db.runs.put(run);
  }

  private emit(e: RunEvent) {
    this.rt.events.publish(e);
  }

  private setNode(run: Run, nr: NodeRun, status: NodeStatus) {
    nr.status = status;
    this.save(run);
    this.emit({ type: 'node_status', runId: run.id, nodeId: nr.nodeId, status });
  }

  private exprContext(run: Run) {
    return {
      inputs: run.inputs,
      nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, n]) => [id, { status: n.status, output: n.output, decision: n.approval?.decision, comment: n.approval?.comment }])),
    };
  }

  private async schedule(runId: string): Promise<void> {
    const run = this.live.get(runId);
    if (!run || TERMINAL_RUN.includes(run.status)) return;
    if (run.status === 'queued') {
      run.status = 'running';
      run.startedAt = now();
      this.save(run);
      this.emit({ type: 'run_status', runId, status: 'running' });
    }
    const states = () => Object.values(run.nodes).map((n) => n.status);
    if (states().includes('failed')) {
      for (const n of Object.values(run.nodes)) if (n.status === 'pending') Object.assign(n, { status: 'skipped', skipReason: '前序节点失败' });
      if (!states().includes('running')) await this.finish(run, 'failed');
      else this.save(run);
      return;
    }
    if (Object.values(run.nodes).some((n) => n.status === 'rejected')) {
      const stopped = run.definition.nodes.some((d) => d.type === 'approval' && d.onReject === 'stop' && run.nodes[d.id].status === 'rejected');
      if (stopped && !states().includes('running')) {
        await this.finish(run, 'rejected');
        return;
      }
    }

    const limit = this.rt.features.PARALLEL_NODES ? this.rt.cfg.workflowConcurrency : 1;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of run.order) {
        const n = run.definition.nodes.find((x) => x.id === id)!;
        const nr = run.nodes[id];
        if (nr.status !== 'pending') continue;
        if (!n.needs.every((d) => FINISHED_NODE.includes(run.nodes[d]?.status))) continue;
        if (n.when?.trim()) {
          let ok = false;
          try {
            ok = evaluate(n.when, this.exprContext(run));
          } catch (e) {
            nr.error = { code: 'CONDITION_ERROR', message: `运行条件计算失败：${(e as Error).message}` };
            run.error = { code: 'CONDITION_ERROR', message: `节点「${n.name}」失败：${nr.error.message}` };
            this.setNode(run, nr, 'failed');
            return this.schedule(runId);
          }
          if (!ok) {
            nr.skipReason = `条件不满足：${n.when}`;
            this.setNode(run, nr, 'skipped');
            progressed = true;
            continue;
          }
        }
        if (n.type === 'approval') {
          nr.startedAt = now();
          nr.approvalRequest = { instructions: n.instructions, approverRole: n.approverRole };
          this.setNode(run, nr, 'waiting_approval');
          this.emit({ type: 'approval_requested', runId, nodeId: id });
          await this.rt.hooks.run('ApprovalRequested', { run, nodeId: id });
          progressed = true;
          continue;
        }
        if ((this.running.get(runId) ?? 0) >= limit) break;
        this.running.set(runId, (this.running.get(runId) ?? 0) + 1);
        nr.startedAt = now();
        nr.error = undefined;
        this.setNode(run, nr, 'running');
        const job = this.runSkillNode(run, n)
          .catch((err) => {
            nr.error = toErrorInfo(err);
            run.error = { code: nr.error.code, message: `节点「${n.name}」失败：${nr.error.message}`, hint: nr.error.hint };
            this.setNode(run, nr, 'failed');
          })
          .finally(() => {
            this.running.set(runId, (this.running.get(runId) ?? 1) - 1);
            return this.schedule(runId);
          });
        this.track(job);
        progressed = true;
      }
    }

    const s = states();
    if (s.every((x) => FINISHED_NODE.includes(x))) await this.finish(run, 'succeeded');
    else if (!s.includes('running') && s.includes('waiting_approval') && run.status !== 'waiting_approval') {
      run.status = 'waiting_approval';
      this.save(run);
      this.emit({ type: 'run_status', runId, status: run.status });
    }
  }

  private doc(orgId: string, id: string) {
    let d = this.docCache.get(id);
    if (!d) {
      d = this.rt.db.documents.get(orgId, id);
      if (this.docCache.size > 100) this.docCache.clear();
      if (d) this.docCache.set(id, d);
    }
    return d;
  }

  private resolve(run: Run, m: Mapping): { text: string; doc?: MaterialDocument } {
    switch (m.type) {
      case 'workflow_input': {
        const def = run.definition.inputs.find((i) => i.key === m.key);
        if (def?.type === 'document' && run.documents[m.key]) {
          const doc = this.doc(run.orgId, run.documents[m.key]);
          return { text: doc?.pages.map((p) => p.text).join('\n\n') ?? '', doc };
        }
        return { text: run.inputs[m.key] ?? '' };
      }
      case 'node_output': {
        const src = run.nodes[m.nodeId];
        if (!src || src.status !== 'succeeded') return { text: '' };
        return { text: toText(getAtPath(src.output, m.path)) };
      }
      case 'literal':
        return { text: m.value };
      case 'coalesce': {
        for (const o of m.options) {
          const r = this.resolve(run, o);
          if (r.doc || r.text.trim()) return r;
        }
        return { text: '' };
      }
    }
  }

  private async runSkillNode(run: Run, n: SkillNode): Promise<void> {
    const nr = run.nodes[n.id];
    const skill = run.skills[n.skillId];
    const cfg: SkillConfig = skill.config;
    const org = this.rt.db.orgs.get(run.orgId)!;
    const starter = this.rt.db.getUser(run.startedBy);
    const inputs: Record<string, string> = {};
    const documents: Record<string, MaterialDocument> = {};
    const shown: Record<string, string> = {};
    for (const d of cfg.inputs) {
      const m = n.mappings[d.key];
      const r = m ? this.resolve(run, m) : { text: d.defaultValue ?? '' };
      if (r.doc) {
        documents[d.key] = r.doc;
        shown[d.key] = `[文档] ${r.doc.filename}（${r.doc.pages.length} 页，${r.doc.method}）\n${r.text.slice(0, 4000)}`;
      } else shown[d.key] = r.text;
      inputs[d.key] = r.text;
    }
    nr.resolvedInputs = shown;
    const channelKey = cfg.verification?.channelInput ?? 'channel';
    const channel = inputs[channelKey] || run.inputs.channel || undefined;
    const exec = await executeSkill({
      runtime: this.rt,
      org,
      skill: { id: n.skillId, name: skill.name, config: cfg },
      inputs,
      documents,
      rulePacks: cfg.rulePackIds.map((id) => {
        const snap = run.rulePacks.find((r) => r.id === id);
        return {
          id,
          name: snap?.name ?? id,
          label: snap?.version === 'draft' ? 'draft — not reviewed' : `approved v${snap?.version} by ${snap?.approval?.approverName ?? '?'}`,
          content: run.rulePackContents[id] ?? { rules: [] },
        };
      }),
      mode: run.mode === 'test' ? 'test' : 'production',
      channel,
      jurisdiction: run.jurisdiction,
      canUseTool: (tool) => (starter ? decide(starter, org.policy, `tool:${tool}`) : 'allow'),
      grantedTools: run.grantedTools,
      fault: run.faultInjection?.nodeId === n.id ? run.faultInjection.type : undefined,
      onTranscript: (entry) => this.emit({ type: 'transcript', runId: run.id, nodeId: n.id, entry }),
    });
    Object.assign(nr, {
      prompt: exec.prompt,
      transcript: exec.transcript,
      rawOutput: exec.rawOutput,
      output: exec.output,
      validation: exec.validation,
      verification: exec.verification,
      security: exec.security,
      usage: exec.usage,
      model: exec.model,
      turns: exec.turns,
      attempts: exec.attempts,
      latencyMs: exec.latencyMs,
      finishedAt: now(),
    });
    run.usage = addUsage(run.usage, exec.usage);
    if (exec.permissionRequest) {
      nr.approvalRequest = {
        instructions: `AI 在执行「${nr.name}」时请求使用工具「${exec.permissionRequest.tool}」。按组织策略，需要审核人批准后才能继续；批准后该节点将重新执行。`,
        approverRole: 'reviewer',
        tool: exec.permissionRequest.tool,
        reason: exec.permissionRequest.reason,
      };
      this.setNode(run, nr, 'waiting_approval');
      this.emit({ type: 'approval_requested', runId: run.id, nodeId: n.id });
      await this.rt.hooks.run('ApprovalRequested', { run, nodeId: n.id });
      return;
    }
    if (!exec.ok) {
      nr.error = exec.error;
      run.error = { code: exec.error?.code ?? 'NODE_FAILED', message: `节点「${n.name}」失败：${exec.error?.message ?? ''}`, hint: exec.error?.hint };
      this.setNode(run, nr, 'failed');
      return;
    }
    this.setNode(run, nr, 'succeeded');
  }

  private async finish(run: Run, status: RunStatus) {
    if (TERMINAL_RUN.includes(run.status)) return;
    run.status = status;
    run.finishedAt = now();
    for (const n of Object.values(run.nodes)) {
      if (n.status === 'pending' || n.status === 'waiting_approval') {
        Object.assign(n, { status: 'skipped', skipReason: n.skipReason ?? (status === 'failed' ? '运行已失败' : '运行已结束'), approvalRequest: undefined });
      }
    }
    if (status === 'succeeded') {
      const designated = run.definition.outputNodeId;
      const candidates = designated && run.nodes[designated]?.status === 'succeeded' ? [designated] : [...run.order].reverse();
      const outId = candidates.find((id) => run.nodes[id].type === 'skill' && run.nodes[id].status === 'succeeded');
      if (outId) {
        run.finalOutput = run.nodes[outId].output;
        run.finalFormat = run.nodes[outId].outputFormat;
        run.finalNodeId = outId;
        if (designated && designated !== outId) run.warnings.push({ code: 'OUTPUT_FALLBACK', message: `指定的最终输出节点未执行，已改用「${run.nodes[outId].name}」的结果。` });
      }
    }
    this.save(run);
    this.live.delete(run.id);
    this.emit({ type: 'run_status', runId: run.id, status });
    await this.rt.hooks.run('RunEnd', { run });
  }
}
