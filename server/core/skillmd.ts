import YAML from 'yaml';
import { skillSlug } from '../../shared/schema';
import type { Skill, SkillConfig } from '../../shared/types';
import { AppError } from '../errors';

const CONFIG_MARK = 'legal-skill-studio:config';

export interface ImportedSkill {
  name: string;
  description: string;
  category?: string;
  jurisdiction?: string;
  config: Partial<SkillConfig> & { instructions: string };
  /** Rule pack ids referenced by the exported file (re-linked by name on import when possible). */
  rulePackNames: string[];
}

/**
 * Exports a skill in the Agent Skills format (https://agentskills.io/specification):
 * YAML frontmatter (name, description, metadata) + Markdown instructions. Platform-specific
 * I/O configuration is appended in an HTML comment so the round-trip is lossless.
 * Rule packs are referenced by name only — their content is governed separately.
 */
export function exportSkillMd(skill: Pick<Skill, 'id' | 'name' | 'description' | 'category' | 'jurisdiction'>, config: SkillConfig, version: number | 'draft', rulePackNames: string[] = []): string {
  const front = {
    name: skillSlug(skill),
    description: (skill.description || skill.name).replace(/\s+/g, ' ').slice(0, 1024),
    metadata: {
      'display-name': skill.name,
      version: String(version),
      ...(skill.category ? { category: skill.category } : {}),
      ...(skill.jurisdiction ? { jurisdiction: skill.jurisdiction } : {}),
      source: 'legal-skill-studio',
    },
  };
  const inputs = config.inputs
    .map((i) => `- \`${i.key}\`（${i.label}${i.type === 'document' ? '，文档' : ''}${i.required ? '，必填' : '，可选'}）${i.description ? `：${i.description}` : ''}`)
    .join('\n');
  const output =
    config.output.format === 'json'
      ? `返回 JSON 对象，字段：\n${config.output.fields.map((f) => `- \`${f.key}\`（${f.type}${f.required ? '，必填' : ''}）${f.label ? `：${f.label}` : ''}`).join('\n')}`
      : '返回 Markdown。';
  const meta = {
    inputs: config.inputs,
    output: config.output,
    checks: config.checks,
    verification: config.verification,
    tools: config.tools,
    rulePacks: rulePackNames,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    testCases: config.testCases,
  };
  return [
    `---\n${YAML.stringify(front).trim()}\n---`,
    `# ${skill.name}`,
    config.instructions.trim(),
    `## Inputs\n\n${inputs}`,
    `## Output\n\n${output}`,
    rulePackNames.length ? `## Rule packs\n\n${rulePackNames.map((n) => `- ${n}`).join('\n')}\n\n（规则包内容由组织单独审核管理，不随 Skill 导出。）` : '',
    config.knowledge?.trim() ? `## Reference\n\n${config.knowledge.trim()}` : '',
    `<!-- ${CONFIG_MARK}\n${JSON.stringify(meta, null, 2).replace(/-->/g, '--\\u003e')}\n-->`,
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

/** Imports a SKILL.md. Files from other tools become a skill with one document input and Markdown output. */
export function importSkillMd(content: string): ImportedSkill {
  const text = content.replace(/^﻿/, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!fm) {
    throw new AppError('IMPORT_INVALID', 'SKILL.md 缺少 YAML frontmatter（以 --- 开始和结束的头部）。', {
      status: 400,
      hint: '文件头部需包含 name 和 description 字段，参见 agentskills.io/specification。',
    });
  }
  let meta: Record<string, unknown>;
  try {
    meta = (YAML.parse(fm[1]) ?? {}) as Record<string, unknown>;
  } catch (err) {
    throw new AppError('IMPORT_INVALID', `SKILL.md 头部 YAML 解析失败：${(err as Error).message}`, { status: 400 });
  }
  if (!meta.name || !meta.description) throw new AppError('IMPORT_INVALID', 'SKILL.md 头部必须包含 name 和 description。', { status: 400 });
  let body = text.slice(fm[0].length);
  let cfg: Record<string, unknown> | undefined;
  const cm = new RegExp(`<!--\\s*${CONFIG_MARK}\\s*([\\s\\S]*?)-->`).exec(body);
  if (cm) {
    try {
      cfg = JSON.parse(cm[1].replace(/--\\u003e/g, '-->'));
    } catch {
      cfg = undefined;
    }
    body = body.replace(cm[0], '').trim();
  }
  const metadata = (meta.metadata ?? {}) as Record<string, string>;
  const name = metadata['display-name'] || String(meta.name).replace(/-/g, ' ');
  const base = { name, description: String(meta.description), category: metadata.category, jurisdiction: metadata.jurisdiction };

  if (cfg) {
    const h1 = /^#\s+.*$/m.exec(body);
    const afterH1 = h1 ? body.slice(h1.index + h1[0].length) : body;
    const inputsHeading = /^##\s+Inputs\s*$/m.exec(afterH1);
    const instructions = (inputsHeading ? afterH1.slice(0, inputsHeading.index) : afterH1).trim();
    // "## Reference" is always the last section we export and may itself contain "##" headings.
    const ref = /^##\s+Reference\s*$/m.exec(body);
    return {
      ...base,
      config: {
        instructions,
        knowledge: ref ? body.slice(ref.index + ref[0].length).trim() : '',
        inputs: cfg.inputs as SkillConfig['inputs'],
        output: cfg.output as SkillConfig['output'],
        checks: (cfg.checks as SkillConfig['checks']) ?? [],
        verification: cfg.verification as SkillConfig['verification'],
        tools: (cfg.tools as string[]) ?? ['read_document', 'search_document'],
        maxTurns: cfg.maxTurns as number | undefined,
        maxTokens: cfg.maxTokens as number | undefined,
        testCases: (cfg.testCases as SkillConfig['testCases']) ?? [],
      },
      rulePackNames: Array.isArray(cfg.rulePacks) ? cfg.rulePacks.map(String) : [],
    };
  }
  return {
    ...base,
    category: base.category || '导入',
    config: {
      instructions: body.trim(),
      knowledge: '',
      inputs: [{ key: 'document', label: '待处理材料', type: 'document', required: true }],
      output: { format: 'markdown', fields: [] },
      checks: [],
      tools: ['read_document', 'search_document'],
      testCases: [],
    },
    rulePackNames: [],
  };
}
