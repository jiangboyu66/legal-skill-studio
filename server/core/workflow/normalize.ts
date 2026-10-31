import type { ApprovalNode, Mapping, Role, SkillNode, WorkflowDef, WorkflowNode } from '../../../shared/types';
import { normInputs } from '../skillConfig';

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v : '').slice(0, max);
const ROLES: Role[] = ['admin', 'builder', 'reviewer', 'runner'];

function normMapping(raw: unknown, depth = 0): Mapping | undefined {
  const m = (raw ?? {}) as Record<string, unknown>;
  switch (m.type) {
    case 'workflow_input':
      return { type: 'workflow_input', key: str(m.key, 40) };
    case 'node_output':
      return { type: 'node_output', nodeId: str(m.nodeId, 40), path: str(m.path, 120).trim() || undefined };
    case 'literal':
      return { type: 'literal', value: str(m.value, 20_000) };
    case 'coalesce': {
      if (depth > 0) return undefined;
      const options = (Array.isArray(m.options) ? m.options : []).map((o) => normMapping(o, depth + 1)).filter((o): o is Mapping => !!o);
      return options.length ? { type: 'coalesce', options } : undefined;
    }
    default:
      return undefined;
  }
}

/** Normalises an untrusted workflow definition (shape only; semantic checks are in validateWorkflowDef). */
export function normalizeWorkflowDef(raw: unknown): WorkflowDef {
  const d = (raw ?? {}) as Record<string, unknown>;
  const nodes: WorkflowNode[] = (Array.isArray(d.nodes) ? d.nodes : []).slice(0, 50).map((r: Record<string, unknown>) => {
    const base = {
      id: str(r?.id, 40).trim(),
      name: str(r?.name, 80).trim() || str(r?.id, 40),
      needs: [...new Set((Array.isArray(r?.needs) ? r.needs : []).map((x: unknown) => String(x)).filter(Boolean))],
      when: str(r?.when, 500).trim() || undefined,
    };
    if (r?.type === 'approval') {
      const n: ApprovalNode = {
        ...base,
        type: 'approval',
        instructions: str(r.instructions, 4000).trim(),
        showNodeIds: (Array.isArray(r.showNodeIds) ? r.showNodeIds : []).map(String).filter(Boolean),
        approverRole: ROLES.includes(r.approverRole as Role) ? (r.approverRole as Role) : 'reviewer',
        onReject: r.onReject === 'continue' ? 'continue' : 'stop',
      };
      return n;
    }
    const mappings: Record<string, Mapping> = {};
    for (const [k, v] of Object.entries((r?.mappings ?? {}) as Record<string, unknown>)) {
      const m = normMapping(v);
      if (m) mappings[k.slice(0, 40)] = m;
    }
    const n: SkillNode = { ...base, type: 'skill', skillId: str(r?.skillId, 80), mappings };
    return n;
  });
  const outputNodeId = str(d.outputNodeId, 40).trim() || undefined;
  return { inputs: normInputs(d.inputs), nodes, outputNodeId };
}
