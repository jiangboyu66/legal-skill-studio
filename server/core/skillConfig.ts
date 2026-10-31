import { randomUUID } from 'node:crypto';
import { isValidKey, listGroundablePaths } from '../../shared/schema';
import type { GroundingCheck, InputField, OutputField, SkillConfig, TestCase, VerificationConfig } from '../../shared/types';
import { AppError } from '../errors';
import { TOOL_REGISTRY } from './tools';

const str = (v: unknown, max = 100_000) => (typeof v === 'string' ? v : '').slice(0, max);
const INPUT_TYPES = ['text', 'long_text', 'document'];
const FIELD_TYPES = ['string', 'number', 'boolean', 'enum', 'string_list', 'object_list'];

export function normInputs(raw: unknown): InputField[] {
  return (Array.isArray(raw) ? raw : []).map((r) => ({
    key: str(r?.key, 40).trim(),
    label: str(r?.label, 80).trim() || str(r?.key, 40).trim(),
    type: INPUT_TYPES.includes(r?.type) ? r.type : 'long_text',
    required: !!r?.required,
    description: str(r?.description, 500).trim() || undefined,
    defaultValue: str(r?.defaultValue) || undefined,
  }));
}

function normFields(raw: unknown, depth = 0): OutputField[] {
  return (Array.isArray(raw) ? raw : []).map((r) => {
    const type = FIELD_TYPES.includes(r?.type) ? r.type : 'string';
    const f: OutputField = {
      key: str(r?.key, 40).trim(),
      label: str(r?.label, 80).trim() || undefined,
      type: depth > 0 && type === 'object_list' ? 'string' : type,
      required: !!r?.required,
      description: str(r?.description, 500).trim() || undefined,
    };
    if (f.type === 'enum') {
      f.options = (Array.isArray(r?.options) ? r.options : String(r?.options ?? '').split(/[,，\n]/)).map((o: unknown) => String(o).trim()).filter(Boolean);
    }
    if (f.type === 'object_list') f.fields = normFields(r?.fields, depth + 1);
    return f;
  });
}

function normVerification(raw: unknown): VerificationConfig | undefined {
  const v = raw as Record<string, unknown> | undefined;
  if (!v || !v.enabled) return undefined;
  return {
    enabled: true,
    listPath: str(v.listPath, 60).trim(),
    ruleIdField: str(v.ruleIdField, 40).trim(),
    quoteField: str(v.quoteField, 40).trim(),
    conclusionField: str(v.conclusionField, 40).trim(),
    severityField: str(v.severityField, 40).trim() || undefined,
    channelInput: str(v.channelInput, 40).trim() || undefined,
    useAgent: v.useAgent !== false,
  };
}

/** Normalises an untrusted skill config and returns human-readable problems (Chinese). */
export function normalizeSkillConfig(body: unknown): { config: SkillConfig; issues: string[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const output = (b.output ?? {}) as Record<string, unknown>;
  const toolNames = new Set(TOOL_REGISTRY.map((t) => t.name));
  const config: SkillConfig = {
    instructions: str(b.instructions).trim(),
    knowledge: str(b.knowledge),
    rulePackIds: (Array.isArray(b.rulePackIds) ? b.rulePackIds : []).map((x) => String(x)).filter(Boolean),
    inputs: normInputs(b.inputs),
    output: { format: output.format === 'json' ? 'json' : 'markdown', fields: output.format === 'json' ? normFields(output.fields) : [] },
    checks: (Array.isArray(b.checks) ? b.checks : []).map(
      (c: Record<string, unknown>): GroundingCheck => ({
        id: str(c?.id, 40) || `chk_${randomUUID().slice(0, 6)}`,
        label: str(c?.label, 60).trim() || '引用核对',
        path: str(c?.path, 120).trim(),
        source: str(c?.source, 60).trim(),
      }),
    ),
    verification: normVerification(b.verification),
    tools: (Array.isArray(b.tools) ? b.tools : []).map(String).filter((t) => toolNames.has(t)),
    maxTurns: Number(b.maxTurns) > 0 ? Math.min(Math.floor(Number(b.maxTurns)), 20) : undefined,
    maxTokens: Number(b.maxTokens) > 0 ? Math.min(Math.floor(Number(b.maxTokens)), 128_000) : undefined,
    testCases: [],
  };
  const keys = new Set(config.inputs.map((i) => i.key));
  config.testCases = (Array.isArray(b.testCases) ? b.testCases : []).map(
    (t: Record<string, unknown>): TestCase => ({
      id: str(t?.id, 40) || `tc_${randomUUID().slice(0, 6)}`,
      name: str(t?.name, 80).trim() || '样例',
      inputs: Object.fromEntries(Object.entries((t?.inputs ?? {}) as Record<string, unknown>).filter(([k]) => keys.has(k)).map(([k, v]) => [k, str(v)])),
    }),
  );

  const issues: string[] = [];
  if (!config.instructions) issues.push('请填写任务说明（告诉 AI 要做什么、按什么标准做）。');
  if (!config.inputs.length) issues.push('至少需要定义一个输入字段。');
  const seen = new Set<string>();
  for (const i of config.inputs) {
    if (!isValidKey(i.key)) issues.push(`输入标识「${i.key || '(空)'}」不合法：须以小写字母开头，只含小写字母、数字、下划线。`);
    if (seen.has(i.key)) issues.push(`输入标识「${i.key}」重复。`);
    seen.add(i.key);
  }
  if (config.output.format === 'json') {
    if (!config.output.fields.length) issues.push('结构化输出至少需要一个字段。');
    const check = (fields: OutputField[], prefix: string) => {
      const ks = new Set<string>();
      for (const f of fields) {
        if (!isValidKey(f.key)) issues.push(`输出字段标识「${prefix}${f.key || '(空)'}」不合法。`);
        if (ks.has(f.key)) issues.push(`输出字段标识「${prefix}${f.key}」重复。`);
        ks.add(f.key);
        if (f.type === 'enum' && !f.options?.length) issues.push(`枚举字段「${prefix}${f.key}」至少需要一个可选值。`);
        if (f.type === 'object_list') {
          if (!f.fields?.length) issues.push(`列表字段「${prefix}${f.key}」至少需要一个子字段。`);
          else check(f.fields, `${prefix}${f.key}[].`);
        }
      }
    };
    check(config.output.fields, '');
  }
  const groundable = new Set(listGroundablePaths(config.output.fields).map((p) => p.path));
  for (const c of config.checks) {
    if (config.output.format !== 'json') {
      issues.push('AI 输出核对仅适用于结构化（JSON）输出。');
      break;
    }
    if (!groundable.has(c.path)) issues.push(`核对规则「${c.label}」的字段路径「${c.path}」不存在或不是文本字段。`);
    if (c.source !== 'knowledge' && !(c.source.startsWith('input:') && keys.has(c.source.slice(6)))) issues.push(`核对规则「${c.label}」的核对来源「${c.source}」无效。`);
  }
  const v = config.verification;
  if (v) {
    const list = config.output.fields.find((f) => f.key === v.listPath && f.type === 'object_list');
    if (!list) issues.push(`结论核验的列表字段「${v.listPath}」必须是输出中的“对象列表”。`);
    else {
      const sub = new Set((list.fields ?? []).map((f) => f.key));
      for (const [label, k] of [['规则编号字段', v.ruleIdField], ['引文字段', v.quoteField], ['结论字段', v.conclusionField]] as const) {
        if (!sub.has(k)) issues.push(`结论核验的${label}「${k}」不在「${v.listPath}」的子字段中。`);
      }
      if (v.severityField && !sub.has(v.severityField)) issues.push(`结论核验的风险字段「${v.severityField}」不在子字段中。`);
    }
    if (!config.rulePackIds.length) issues.push('启用结论核验需要至少关联一个规则包。');
  }
  return { config, issues };
}

export function assertValidSkillConfig(body: unknown): SkillConfig {
  const { config, issues } = normalizeSkillConfig(body);
  if (issues.length) {
    throw new AppError('SKILL_INVALID', `Skill 配置有误：${issues[0]}`, {
      status: 400,
      hint: issues.length > 1 ? `共 ${issues.length} 处问题，请逐项修改。` : undefined,
      details: { issues },
    });
  }
  return config;
}
