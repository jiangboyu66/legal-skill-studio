import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { skillSlug } from '../../shared/schema';
import type { FaultType, MaterialDocument, Org, RulePackSnapshot, RunWarning, Skill, SkillConfig, SkillTestResult, SkillView, User } from '../../shared/types';
import type { AppContext } from '../context';
import { requirePermission } from '../core/permissions';
import { assertValidSkillConfig } from '../core/skillConfig';
import { exportSkillMd, importSkillMd } from '../core/skillmd';
import { executeSkill, type PackForRun } from '../core/skills';
import { rulePackStatus } from '../core/workflow/engine';
import { decide } from '../core/permissions';
import { AppError, Errors } from '../errors';
import { consumerOnly, h, param, requireAny, text, who } from './util';
import { consumerSkillView, skillViews } from './views';

const FAULTS: FaultType[] = ['none', 'auth', 'rate_limit', 'timeout', 'server_error', 'bad_output', 'bad_output_once'];

export function skillsRouter(ctx: AppContext) {
  const r = Router();
  const { db } = ctx;

  const get = (org: Org, id: string) => {
    const s = db.skills.get(org.id, id);
    if (!s) throw Errors.notFound('Skill');
    return s;
  };
  const view = (org: Org, s: Skill) => skillViews(db, org.id, [s])[0];
  /** 使用者 only see published skills, without the authoring parts. */
  const viewFor = (user: User, org: Org, s: Skill) => {
    const v = view(org, s);
    if (!consumerOnly(user, org, 'skill')) return v;
    const c = consumerSkillView(db, org.id, v);
    if (!c) throw Errors.notFound('Skill');
    return c;
  };

  const meta = (body: Record<string, unknown>) => {
    const name = text(body.name, 80);
    if (!name) throw Errors.badRequest('请填写 Skill 名称。');
    return { name, description: text(body.description, 1000), category: text(body.category, 40) || undefined, jurisdiction: text(body.jurisdiction, 40) || undefined };
  };
  const config = (org: Org, raw: unknown): SkillConfig => {
    const c = assertValidSkillConfig(raw);
    const missing = c.rulePackIds.filter((id) => !db.rulePacks.get(org.id, id));
    if (missing.length) throw Errors.badRequest(`关联的规则包不存在：${missing.join('、')}。`);
    return c;
  };
  const assertEditable = (s: Skill) => {
    if (s.status === 'in_review') throw Errors.conflict('该 Skill 正在审核中，内容已锁定。', '如需修改，请先在“审核”页撤回发布申请。');
  };

  r.get(
    '/',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.view');
      const views = skillViews(db, org.id, db.skills.list(org.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      if (!consumerOnly(user, org, 'skill')) return views;
      return views.map((v) => consumerSkillView(db, org.id, v)).filter((v): v is SkillView => !!v);
    }),
  );

  r.post(
    '/',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.edit');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ts = new Date().toISOString();
      const s: Skill = {
        id: `skl_${randomUUID().slice(0, 8)}`,
        orgId: org.id,
        ...meta(body),
        source: 'user',
        status: 'draft',
        draft: config(org, body.config),
        versions: [],
        createdBy: user.id,
        updatedBy: user.id,
        createdAt: ts,
        updatedAt: ts,
      };
      db.skills.put(s);
      ctx.rt.audit(org.id, user, 'skill.create', 'skill', s.id, { name: s.name });
      res.status(201);
      return view(org, s);
    }),
  );

  r.post(
    '/import',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.edit');
      const content = (req.body as { content?: unknown })?.content;
      if (typeof content !== 'string' || !content.trim()) throw Errors.badRequest('请提供 SKILL.md 文件内容。');
      if (content.length > 500_000) throw Errors.badRequest('SKILL.md 文件过大（超过 500KB）。');
      const imported = importSkillMd(content);
      const warnings: string[] = [];
      const packs = db.rulePacks.list(org.id);
      const rulePackIds = imported.rulePackNames.map((n) => packs.find((p) => p.name === n)?.id).filter((x): x is string => !!x);
      if (rulePackIds.length < imported.rulePackNames.length) warnings.push('部分规则包在本组织中不存在，已取消关联。');
      const raw = { ...imported.config, rulePackIds };
      if (raw.verification?.enabled && !rulePackIds.length) {
        raw.verification = undefined;
        warnings.push('未找到可关联的规则包，已关闭“结论核验”。');
      }
      const ts = new Date().toISOString();
      const s: Skill = {
        id: `skl_${randomUUID().slice(0, 8)}`,
        orgId: org.id,
        ...meta(imported as unknown as Record<string, unknown>),
        source: 'user',
        status: 'draft',
        draft: config(org, raw),
        versions: [],
        createdBy: user.id,
        updatedBy: user.id,
        createdAt: ts,
        updatedAt: ts,
      };
      db.skills.put(s);
      ctx.rt.audit(org.id, user, 'skill.import', 'skill', s.id, { name: s.name });
      res.status(201);
      return { skill: view(org, s), warnings };
    }),
  );

  r.get(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.view');
      return viewFor(user, org, get(org, param(req, 'id')));
    }),
  );

  r.put(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.edit');
      const s = get(org, param(req, 'id'));
      assertEditable(s);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const next: Skill = { ...s, ...meta(body), draft: config(org, body.config), status: s.publishedVersion ? 'published' : 'draft', updatedBy: user.id, updatedAt: new Date().toISOString() };
      db.skills.put(next);
      ctx.rt.audit(org.id, user, 'skill.update', 'skill', s.id);
      return view(org, next);
    }),
  );

  r.delete(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.delete');
      const s = get(org, param(req, 'id'));
      assertEditable(s);
      const used = view(org, s).usedBy;
      if (used.length) throw Errors.conflict(`该 Skill 正被工作流使用：${used.map((w) => `「${w.name}」`).join('、')}。`, '请先从这些工作流中移除该 Skill。');
      db.skills.delete(org.id, s.id);
      ctx.rt.audit(org.id, user, 'skill.delete', 'skill', s.id, { name: s.name });
      return { ok: true };
    }),
  );

  r.post(
    '/:id/duplicate',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.edit');
      const src = get(org, param(req, 'id'));
      const ts = new Date().toISOString();
      const s: Skill = {
        ...structuredClone(src),
        id: `skl_${randomUUID().slice(0, 8)}`,
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
      db.skills.put(s);
      ctx.rt.audit(org.id, user, 'skill.duplicate', 'skill', s.id, { from: src.id });
      res.status(201);
      return view(org, s);
    }),
  );

  r.post(
    '/:id/submit',
    h((req) => {
      const { user, org } = who(req);
      return ctx.governance.submit(org, user, 'skill', param(req, 'id'), text((req.body as { note?: unknown })?.note, 1000));
    }),
  );

  r.get(
    '/:id/versions/:v',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.view');
      requireAny(user, org, ['skill.edit', 'skill.approve'], '查看 Skill 历史版本的完整配置');
      const s = get(org, param(req, 'id'));
      const cfg = db.getVersion<SkillConfig>('skill', s.id, Number(param(req, 'v')));
      if (!cfg) throw Errors.notFound('该版本');
      return cfg;
    }),
  );

  r.get(
    '/:id/export',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'skill.view');
      requireAny(user, org, ['skill.edit', 'skill.approve'], '导出 SKILL.md');
      const s = get(org, param(req, 'id'));
      const usePublished = req.query.version === 'published' && s.published;
      const cfg = usePublished ? s.published! : s.draft;
      const names = cfg.rulePackIds.map((id) => db.rulePacks.get(org.id, id)?.name).filter((n): n is string => !!n);
      const md = exportSkillMd(s, cfg, usePublished ? s.publishedVersion! : 'draft', names);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${skillSlug(s)}-SKILL.md"`);
      res.send(md);
    }),
  );

  /** Test a skill on sample inputs (draft config, or an unsaved config sent by the editor). */
  r.post(
    '/:id/test',
    h(async (req): Promise<SkillTestResult> => {
      const { user, org } = who(req);
      requireAny(user, org, ['skill.edit', 'skill.approve'], '测试 Skill');
      const s = get(org, param(req, 'id'));
      const body = (req.body ?? {}) as { inputs?: Record<string, unknown>; config?: unknown; fault?: FaultType; target?: string };
      const cfg = body.config ? config(org, body.config) : body.target === 'published' && s.published ? s.published : s.draft;
      return runSkillTest(ctx, org, user, { id: s.id, name: s.name, config: cfg }, body.inputs ?? {}, FAULTS.includes(body.fault as FaultType) ? body.fault : undefined);
    }),
  );

  return r;
}

/** Shared by the skill editor: resolves document inputs and rule packs, then executes the skill once. */
export async function runSkillTest(ctx: AppContext, org: Org, user: User, skill: { id: string; name: string; config: SkillConfig }, raw: Record<string, unknown>, fault?: FaultType): Promise<SkillTestResult> {
  const { db } = ctx;
  const warnings: RunWarning[] = [];
  const documents: Record<string, MaterialDocument> = {};
  const inputs: Record<string, string> = {};
  for (const def of skill.config.inputs) {
    const v = raw[def.key];
    const docId = typeof v === 'object' && v ? String((v as { documentId?: string }).documentId ?? '') : typeof v === 'string' && /^doc_[\w-]+$/.test(v.trim()) ? v.trim() : '';
    if (docId) {
      const d = db.documents.get(org.id, docId);
      if (!d) throw Errors.badRequest(`输入「${def.label}」引用的文档不存在。`, '请重新上传文件。');
      documents[def.key] = d;
      inputs[def.key] = '';
    } else inputs[def.key] = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  }
  const rulePacks: RulePackSnapshot[] = [];
  const packs: PackForRun[] = skill.config.rulePackIds.map((id) => {
    const rp = db.rulePacks.get(org.id, id);
    if (!rp) throw Errors.notFound('Skill 关联的规则包');
    const status = rulePackStatus(rp);
    rulePacks.push({ id, name: rp.name, version: 'draft', status, approval: rp.approval });
    if (status !== 'approved') warnings.push({ code: 'RULEPACK_UNREVIEWED', message: `规则包「${rp.name}」当前为「${{ draft: '草稿', in_review: '待审核', approved: '已批准', expired: '已过期' }[status]}」，测试使用其草稿内容，结果仅供调试。` });
    return { id, name: rp.name, label: 'draft — not reviewed (test run)', content: rp.draft };
  });
  if (fault && fault !== 'none') warnings.push({ code: 'FAULT_INJECTED', message: `已注入故障：${fault}（仅用于演示错误处理）。` });
  const execution = await executeSkill({
    runtime: ctx.rt,
    org,
    skill,
    inputs,
    documents,
    rulePacks: packs,
    mode: 'test',
    channel: inputs[skill.config.verification?.channelInput ?? 'channel'] || undefined,
    canUseTool: (tool) => decide(user, org.policy, `tool:${tool}`),
    // A tool marked "ask" pauses workflow runs for approval; in an interactive test the builder is the one asking.
    grantedTools: [],
    fault,
  });
  if (execution.permissionRequest) {
    execution.error = new AppError('PERMISSION_REQUIRED', `组织策略要求使用工具「${execution.permissionRequest.tool}」前需人工批准。`, {
      hint: '在工作流运行中，该节点会暂停并等待审核人批准；单独测试 Skill 时无法批准，请在 Skill 的工具设置中取消该工具或调整组织策略。',
    }).toInfo();
  }
  ctx.rt.audit(org.id, user, 'skill.test', 'skill', skill.id, { ok: execution.ok, error: execution.error?.code });
  return { execution, warnings, rulePacks, provider: ctx.provider.info };
}
