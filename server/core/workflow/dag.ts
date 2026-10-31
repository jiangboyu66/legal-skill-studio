import { isValidKey } from '../../../shared/schema';
import type { InputField, Mapping, Role, SkillConfig, ValidationIssue, WorkflowDef, WorkflowNode } from '../../../shared/types';
import { referencedNodes } from './expr';

export type SkillLookup = (skillId: string) => { name: string; config: SkillConfig } | undefined;

/** Topological order (Kahn). Returns null when the graph has a cycle. */
export function topoOrder(nodes: WorkflowNode[]): string[] | null {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) for (const d of n.needs) if (ids.has(d)) indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const n of nodes) {
      if (n.needs.includes(id)) {
        indeg.set(n.id, (indeg.get(n.id) ?? 0) - 1);
        if (indeg.get(n.id) === 0) queue.push(n.id);
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/** Transitive upstream set for every node. */
export function ancestors(nodes: WorkflowNode[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const out = new Set<string>();
    if (stack.has(id)) return out;
    stack.add(id);
    for (const d of byId.get(id)?.needs ?? []) {
      out.add(d);
      for (const a of visit(d, stack)) out.add(a);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const n of nodes) visit(n.id, new Set());
  return memo;
}

function mappingSources(m: Mapping): Mapping[] {
  return m.type === 'coalesce' ? m.options.flatMap(mappingSources) : [m];
}

const ROLES: Role[] = ['admin', 'builder', 'reviewer', 'runner'];

/** Static validation run on save (shown in the editor) and before every run (errors block the run). */
export function validateWorkflowDef(def: WorkflowDef, lookup: SkillLookup, name?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string, field?: string) => issues.push({ level: 'error', message, nodeId, field });
  const warn = (message: string, nodeId?: string, field?: string) => issues.push({ level: 'warning', message, nodeId, field });

  if (name !== undefined && !name.trim()) err('工作流名称不能为空。');
  const inputKeys = new Map<string, InputField>();
  for (const inp of def.inputs) {
    if (!isValidKey(inp.key)) err(`工作流输入的标识「${inp.key}」不合法（小写字母开头，只含小写字母、数字、下划线）。`);
    if (inputKeys.has(inp.key)) err(`工作流输入的标识「${inp.key}」重复。`);
    inputKeys.set(inp.key, inp);
  }
  if (!def.nodes.length) {
    err('至少需要添加一个节点。');
    return issues;
  }
  const ids = new Set<string>();
  for (const n of def.nodes) {
    if (!isValidKey(n.id)) err(`节点标识「${n.id}」不合法。`, n.id);
    if (ids.has(n.id)) err(`节点标识「${n.id}」重复。`, n.id);
    ids.add(n.id);
  }
  for (const n of def.nodes) {
    for (const d of n.needs) {
      if (d === n.id) err(`节点「${n.name}」不能依赖自己。`, n.id);
      else if (!ids.has(d)) err(`节点「${n.name}」依赖的节点「${d}」不存在。`, n.id);
    }
  }
  if (!topoOrder(def.nodes)) {
    err('节点依赖存在循环，请检查“依赖”设置。');
    return issues;
  }
  const anc = ancestors(def.nodes);
  const label = (n: WorkflowNode) => `节点「${n.name || n.id}」`;

  for (const n of def.nodes) {
    const up = anc.get(n.id) ?? new Set<string>();
    if (n.when?.trim()) {
      try {
        for (const ref of referencedNodes(n.when)) {
          if (!ids.has(ref)) err(`${label(n)} 的运行条件引用了不存在的节点「${ref}」。`, n.id, 'when');
          else if (!up.has(ref)) err(`${label(n)} 的运行条件引用了「${ref}」，但它不在该节点的上游（请把它加入依赖）。`, n.id, 'when');
        }
      } catch (e) {
        err(`${label(n)} 的运行条件无法解析：${(e as Error).message}`, n.id, 'when');
      }
    }
    if (n.type === 'approval') {
      if (!ROLES.includes(n.approverRole)) err(`${label(n)} 的审批角色无效。`, n.id);
      for (const s of n.showNodeIds) if (!up.has(s)) err(`${label(n)} 要展示的节点「${s}」不在其上游。`, n.id);
      if (!n.needs.length) warn(`${label(n)} 没有上游节点，审批人将看不到任何结果。`, n.id);
      continue;
    }
    const skill = lookup(n.skillId);
    if (!skill) {
      err(`${label(n)} 引用的 Skill 不存在（可能已被删除或尚未发布），请重新选择。`, n.id);
      continue;
    }
    const skillInputs = new Set(skill.config.inputs.map((i) => i.key));
    for (const [key, mapping] of Object.entries(n.mappings)) {
      if (!skillInputs.has(key)) {
        warn(`${label(n)} 为 Skill 中不存在的输入「${key}」配置了来源（Skill 可能已修改），该配置会被忽略。`, n.id, key);
        continue;
      }
      for (const m of mappingSources(mapping)) {
        if (m.type === 'workflow_input' && !inputKeys.has(m.key)) err(`${label(n)} 的输入「${key}」引用了不存在的工作流输入「${m.key}」。`, n.id, key);
        if (m.type === 'node_output') {
          const src = def.nodes.find((x) => x.id === m.nodeId);
          if (!src) err(`${label(n)} 的输入「${key}」引用的节点「${m.nodeId}」不存在。`, n.id, key);
          else if (!up.has(m.nodeId)) err(`${label(n)} 的输入「${key}」引用了「${src.name}」，但它不在上游（请把它加入依赖）。`, n.id, key);
          else if (m.path && src.type === 'skill') {
            const ss = lookup(src.skillId);
            if (ss && ss.config.output.format !== 'json') err(`${label(n)} 的输入「${key}」引用了「${src.name}」的字段「${m.path}」，但其输出为 Markdown。`, n.id, key);
            else if (ss && !ss.config.output.fields.some((f) => f.key === m.path!.split('.')[0])) err(`${label(n)} 的输入「${key}」引用的字段「${m.path}」在「${src.name}」的输出中不存在。`, n.id, key);
          }
        }
        if (m.type === 'literal' && !m.value.trim()) warn(`${label(n)} 的输入「${key}」配置为固定文本但内容为空。`, n.id, key);
      }
    }
    for (const def2 of skill.config.inputs) {
      if (def2.required && !n.mappings[def2.key] && !def2.defaultValue) err(`${label(n)} 的必填输入「${def2.label}」未配置来源。`, n.id, def2.key);
    }
  }
  if (def.outputNodeId && !ids.has(def.outputNodeId)) err('“最终输出节点”不存在。');
  return issues;
}
