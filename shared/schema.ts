// Helpers shared by server and client: output-field -> JSON Schema, path utilities, key validation.
import type { OutputField, Skill, SkillConfig } from './types';

export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

type JsonSchema = Record<string, unknown>;

function fieldSchema(f: OutputField): JsonSchema {
  const desc = [f.label, f.description].filter(Boolean).join(' — ') || undefined;
  const base: JsonSchema = desc ? { description: desc } : {};
  switch (f.type) {
    case 'string':
      return { ...base, type: 'string' };
    case 'number':
      return { ...base, type: 'number' };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'enum':
      return { ...base, type: 'string', enum: (f.options ?? []).filter(Boolean) };
    case 'string_list':
      return { ...base, type: 'array', items: { type: 'string' } };
    case 'object_list': {
      const sub = (f.fields ?? []).filter((s) => s.type !== 'object_list');
      return {
        ...base,
        type: 'array',
        items: {
          type: 'object',
          properties: Object.fromEntries(sub.map((s) => [s.key, fieldSchema(s)])),
          required: sub.filter((s) => s.required).map((s) => s.key),
        },
      };
    }
    default:
      return base;
  }
}

/** Builds a JSON Schema (draft-07 compatible) for a skill's structured output. */
export function buildOutputSchema(fields: OutputField[]): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((f) => [f.key, fieldSchema(f)])),
    required: fields.filter((f) => f.required).map((f) => f.key),
  };
}

/** Human-readable field guidance appended to the prompt. */
export function describeFields(fields: OutputField[], prefix = ''): string[] {
  const lines: string[] = [];
  for (const f of fields) {
    const name = `${prefix}${f.key}${f.type === 'object_list' || f.type === 'string_list' ? '[]' : ''}`;
    const typeLabel =
      f.type === 'enum' ? `one of: ${(f.options ?? []).join(' | ')}` : f.type.replace('_', ' ');
    const text = [f.label, f.description].filter(Boolean).join(' — ');
    lines.push(`- ${name} (${typeLabel}${f.required ? ', required' : ', optional'})${text ? `: ${text}` : ''}`);
    if (f.type === 'object_list' && f.fields?.length) {
      lines.push(...describeFields(f.fields, `${name}.`));
    }
  }
  return lines;
}

/**
 * Paths that can be referenced by grounding checks or workflow mappings.
 * Returns e.g. ["summary", "claims", "claims[].quote", "risk_flags[]"]
 */
export function listOutputPaths(fields: OutputField[]): { path: string; type: string; label: string }[] {
  const out: { path: string; type: string; label: string }[] = [];
  for (const f of fields) {
    out.push({ path: f.key, type: f.type, label: f.label || f.key });
    if (f.type === 'string_list') {
      out.push({ path: `${f.key}[]`, type: 'string', label: `${f.label || f.key} 的每一项` });
    }
    if (f.type === 'object_list') {
      for (const s of f.fields ?? []) {
        out.push({
          path: `${f.key}[].${s.key}`,
          type: s.type,
          label: `${f.label || f.key} › ${s.label || s.key}`,
        });
      }
    }
  }
  return out;
}

/** Text-like paths suitable for grounding checks (strings or string lists). */
export function listGroundablePaths(fields: OutputField[]) {
  return listOutputPaths(fields).filter((p) => p.type === 'string' || p.type === 'enum');
}

export interface PathValue {
  location: string;
  value: unknown;
}

/**
 * Collects values at a simple path. Supports "a", "a.b", "a[]", "a[].b".
 * Locations are concrete, e.g. "claims[2].quote".
 */
export function collectPath(root: unknown, path: string): PathValue[] {
  const tokens = path.split('.').filter(Boolean);
  let current: PathValue[] = [{ location: '', value: root }];
  for (const token of tokens) {
    const isArray = token.endsWith('[]');
    const key = isArray ? token.slice(0, -2) : token;
    const next: PathValue[] = [];
    for (const { location, value } of current) {
      if (value === null || typeof value !== 'object') continue;
      const child = key ? (value as Record<string, unknown>)[key] : value;
      const childLoc = key ? (location ? `${location}.${key}` : key) : location;
      if (isArray) {
        if (Array.isArray(child)) {
          child.forEach((item, i) => next.push({ location: `${childLoc}[${i}]`, value: item }));
        }
      } else if (child !== undefined) {
        next.push({ location: childLoc, value: child });
      }
    }
    current = next;
  }
  return current;
}

/** Returns the value at a dotted path (no [] support) – used for workflow mappings. */
export function getAtPath(root: unknown, path?: string): unknown {
  if (!path) return root;
  let cur: unknown = root;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function emptySkillConfig(): SkillConfig {
  return {
    instructions: '',
    knowledge: '',
    rulePackIds: [],
    inputs: [{ key: 'document', label: '待处理材料', type: 'long_text', required: true }],
    output: { format: 'markdown', fields: [] },
    checks: [],
    tools: ['read_document', 'search_document'],
    testCases: [],
  };
}

/** Actions checked by the permission engine (labels used by the admin UI). */
export const ACTIONS: Record<string, string> = {
  'skill.view': '查看 Skill',
  'skill.edit': '编辑 Skill 草稿',
  'skill.submit': '提交 Skill 发布',
  'skill.approve': '批准 Skill 发布',
  'skill.delete': '删除 Skill',
  'workflow.view': '查看工作流',
  'workflow.edit': '编辑工作流草稿',
  'workflow.submit': '提交工作流发布',
  'workflow.approve': '批准工作流发布',
  'workflow.delete': '删除工作流',
  'workflow.run': '运行已发布工作流',
  'workflow.test': '测试运行草稿',
  'rulepack.view': '查看规则包',
  'rulepack.edit': '编辑规则包草稿',
  'rulepack.submit': '提交规则包审核',
  'rulepack.approve': '审核批准规则包',
  'run.view_all': '查看所有人的运行',
  'run.approve_node': '处理运行中的审批节点',
  'run.review': '复核运行结果',
  'run.view_internals': '查看提示词与模型原始返回',
  'review.view': '进入“审核与审批”（发布申请、审批待办）',
  'document.upload': '上传物料',
  'admin.users': '管理用户',
  'admin.policy': '管理组织策略',
  'audit.view': '查看审计日志',
};

export const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  builder: '创建者（法务运营）',
  reviewer: '法律审核人',
  runner: '使用者',
};

export function skillSlug(skill: Pick<Skill, 'name' | 'id'>): string {
  const ascii = skill.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/g, '');
  return ascii || `skill-${skill.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-12)}`;
}
