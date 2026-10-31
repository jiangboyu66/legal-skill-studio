import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { Mapping, Org, PluginInfo, RulePack, RulePackContent, Skill, SkillConfig, User, Workflow, WorkflowDef, WorkflowNode } from '../../shared/types';
import type { AgentDefinition } from '../core/agents';
import { normalizeSkillConfig } from '../core/skillConfig';
import type { Db } from '../services/storage/db';

/**
 * Plugin system (cf. plugin.json with skills / agents / commands / hooks):
 * a plugin is a folder whose manifest declares skills (SKILL.md + skill.json), rule packs,
 * workflow templates and agents. Plugins contribute content only — executable hooks are
 * restricted to reviewed built-in code so third-party plugins cannot run code on the server.
 */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  skills?: string[];
  rulePacks?: string[];
  workflows?: string[];
  agents?: string[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  builtIn: boolean;
  skills: { key: string; name: string; description: string; category?: string; jurisdiction?: string; config: SkillConfig & { rulePackKeys?: string[] } }[];
  rulePacks: { key: string; name: string; jurisdiction: string; description: string; content: RulePackContent }[];
  workflows: { key: string; name: string; description: string; def: WorkflowDef & { nodes: (WorkflowNode & { skill?: string })[] } }[];
  agents: AgentDefinition[];
}

const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundled');

function readFrontmatter(file: string): { meta: Record<string, unknown>; body: string } {
  const text = readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: (YAML.parse(m[1]) ?? {}) as Record<string, unknown>, body: text.slice(m[0].length).trim() };
}

export function loadPlugin(dir: string, builtIn: boolean): LoadedPlugin {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest;
  const skills = (manifest.skills ?? []).map((rel) => {
    const sdir = path.join(dir, rel);
    const { meta, body } = readFrontmatter(path.join(sdir, 'SKILL.md'));
    const extra = JSON.parse(readFileSync(path.join(sdir, 'skill.json'), 'utf8')) as Record<string, unknown>;
    const { config, issues } = normalizeSkillConfig({ ...extra, instructions: body, rulePackIds: extra.rulePacks ?? [] });
    if (issues.length) throw new Error(`插件 ${manifest.name} 的 Skill ${rel} 配置有误：${issues.join('；')}`);
    const md = (meta.metadata ?? {}) as Record<string, string>;
    return {
      key: String(meta.name),
      name: md['display-name'] ?? String(meta.name),
      description: String(meta.description ?? ''),
      category: md.category,
      jurisdiction: md.jurisdiction,
      config: { ...config, testCases: (extra.testCases as SkillConfig['testCases']) ?? [] },
    };
  });
  const rulePacks = (manifest.rulePacks ?? []).map((rel) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8')));
  const workflows = (manifest.workflows ?? []).map((rel) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8')));
  const agents = (manifest.agents ?? []).map((rel): AgentDefinition => {
    const { meta, body } = readFrontmatter(path.join(dir, rel));
    return {
      agentType: String(meta.agentType ?? meta.name),
      description: String(meta.description ?? ''),
      tools: Array.isArray(meta.tools) ? meta.tools.map(String) : undefined,
      maxTurns: Number(meta.maxTurns) || undefined,
      prompt: body,
      source: `plugin:${manifest.name}`,
    };
  });
  return { manifest, builtIn, skills, rulePacks, workflows, agents };
}

/** Scans bundled plugins plus DATA_DIR/plugins (installed plugins). */
export function loadPlugins(dataDir: string): LoadedPlugin[] {
  const dirs: [string, boolean][] = [];
  for (const [base, builtIn] of [[BUNDLED_DIR, true], [path.join(dataDir, 'plugins'), false]] as const) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(path.join(base, d.name, 'plugin.json'))) dirs.push([path.join(base, d.name), builtIn]);
    }
  }
  return dirs.map(([d, b]) => loadPlugin(d, b));
}

export function pluginInfo(p: LoadedPlugin): PluginInfo {
  return {
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description,
    builtIn: p.builtIn,
    contributes: {
      skills: p.skills.map((s) => s.name),
      rulePacks: p.rulePacks.map((r) => r.name),
      workflows: p.workflows.map((w) => w.name),
      agents: p.agents.map((a) => a.agentType),
      hooks: [],
    },
  };
}

const idFor = (prefix: string, org: Org, key: string) => `${prefix}_${org.id.replace(/^org_/, '')}_${key.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;

/**
 * Installs a plugin's content into an organisation: skills and workflow templates as published v1
 * (vendor-provided), rule packs as "in review" — they must be approved by the org's own legal reviewer.
 */
export function installPlugin(db: Db, org: Org, plugin: LoadedPlugin, by: Pick<User, 'id' | 'name'>) {
  const ts = new Date().toISOString();
  const source = `plugin:${plugin.manifest.name}` as const;
  const packIds = new Map<string, string>();
  for (const rp of plugin.rulePacks) {
    const id = idFor('rp', org, rp.key);
    packIds.set(rp.key, id);
    if (db.rulePacks.get(org.id, id)) continue;
    const pack: RulePack = { id, orgId: org.id, name: rp.name, jurisdiction: rp.jurisdiction, description: rp.description, source, status: 'in_review', draft: rp.content, history: [], updatedAt: ts, updatedBy: by.id };
    db.rulePacks.put(pack);
    // Vendor content is never trusted as-is: it enters the org's review queue for its own legal reviewer.
    db.reviews.put({
      id: `rev_${id.slice(3)}`,
      orgId: org.id,
      entityType: 'rulepack',
      entityId: id,
      entityName: rp.name,
      status: 'pending',
      submittedBy: by.id,
      submittedByName: by.name,
      note: `随插件 ${plugin.manifest.name}@${plugin.manifest.version} 安装。规则整理自公开资料，须由本组织具备资质的法律审核人逐条核对来源与适用范围后批准。`,
      snapshot: rp.content,
      createdAt: ts,
    });
  }
  const skillIds = new Map<string, string>();
  for (const s of plugin.skills) {
    const id = idFor('skl', org, s.key);
    skillIds.set(s.key, id);
    if (db.skills.get(org.id, id)) continue;
    const config: SkillConfig = { ...s.config, rulePackIds: s.config.rulePackIds.map((k) => packIds.get(k) ?? k) };
    const skill: Skill = {
      id, orgId: org.id, name: s.name, description: s.description, category: s.category, jurisdiction: s.jurisdiction, source,
      status: 'published', draft: config, published: config, publishedVersion: 1,
      versions: [{ version: 1, approvedBy: by.id, approvedByName: by.name, approvedAt: ts, changelog: `随插件 ${plugin.manifest.name}@${plugin.manifest.version} 安装` }],
      createdBy: by.id, updatedBy: by.id, createdAt: ts, updatedAt: ts,
    };
    db.skills.put(skill);
    db.putVersion('skill', id, 1, config);
  }
  for (const w of plugin.workflows) {
    const id = idFor('wf', org, w.key);
    if (db.workflows.get(org.id, id)) continue;
    const mapIds = (m: Mapping): Mapping => (m.type === 'coalesce' ? { ...m, options: m.options.map(mapIds) } : m);
    const def: WorkflowDef = {
      inputs: w.def.inputs,
      outputNodeId: w.def.outputNodeId,
      nodes: w.def.nodes.map((n) =>
        n.type === 'skill'
          ? { id: n.id, type: 'skill', name: n.name, needs: n.needs ?? [], when: n.when, skillId: skillIds.get((n as { skill?: string }).skill ?? '') ?? n.skillId, mappings: Object.fromEntries(Object.entries(n.mappings).map(([k, m]) => [k, mapIds(m)])) }
          : { ...n, needs: n.needs ?? [] },
      ),
    };
    // The published version pins the skill versions it was installed with (all v1).
    const pins = Object.fromEntries(def.nodes.filter((n) => n.type === 'skill').map((n) => [(n as { skillId: string }).skillId, db.skills.get(org.id, (n as { skillId: string }).skillId)?.publishedVersion ?? 1]));
    const published: WorkflowDef = { ...structuredClone(def), pins };
    const wf: Workflow = {
      id, orgId: org.id, name: w.name, description: w.description, source, status: 'published', draft: def, published, publishedVersion: 1,
      versions: [{ version: 1, approvedBy: by.id, approvedByName: by.name, approvedAt: ts, changelog: `随插件 ${plugin.manifest.name}@${plugin.manifest.version} 安装` }],
      createdBy: by.id, updatedBy: by.id, createdAt: ts, updatedAt: ts,
    };
    db.workflows.put(wf);
    db.putVersion('workflow', id, 1, published);
  }
}
