import type { ChatAttachment, Conversation, ConversationMessage, ConversationSummary, InputField, MaterialDocument, Org, Run, SkillConfig, SkillExecution, User } from '../../shared/types';
import { RESULT_QA } from './agents';
import { decide } from './permissions';
import type { Runtime } from './runtime';
import { executeSkill } from './skills';

/**
 * Chat home: a conversation is a thread of "review this material" requests (each starts a normal workflow
 * run) and follow-up questions answered from one run's results. Runs stay ordinary runs — the chat only
 * references them, so permissions, audit, export and replay work the same as on the run page.
 */

export const DEFAULT_TITLE = '新对话';
const CONTEXT_LIMIT = 60_000;

/** Internal skill used for follow-up questions (never stored in the skills table, never published). */
export const QA_SKILL: { id: string; name: string; config: SkillConfig } = {
  id: 'builtin_result_qa',
  name: '结果追问',
  config: {
    instructions:
      'Answer the question in the "question" input about the run described in the "run_result" input. Use the "history" input for context of earlier questions. ' +
      'When the answer depends on the exact wording of the material, check it with read_document or search_document; when it depends on a rule, use lookup_rule. ' +
      'Refer to findings by their number (#1, #2 …) and rule ID. If the run failed or has no result for what is asked, say so.',
    knowledge: '',
    rulePackIds: [],
    inputs: [
      { key: 'question', label: '追问', type: 'text', required: true },
      { key: 'run_result', label: '运行结果', type: 'long_text', required: true },
      { key: 'history', label: '此前的问答', type: 'long_text', required: false },
      { key: 'material', label: '原始材料', type: 'document', required: false },
    ],
    output: { format: 'markdown', fields: [] },
    checks: [],
    tools: ['read_document', 'search_document', 'lookup_rule'],
    maxTurns: 4,
    testCases: [],
  },
};

const clipJson = (v: unknown, max: number): unknown => {
  const s = JSON.stringify(v ?? null);
  if (s.length <= max) return v;
  return `${s.slice(0, max)}…（已截断）`;
};

/** The run as the follow-up agent sees it: results, review marks and verification notes, size-capped. */
export function runContextJson(run: Run): string {
  const nodes = run.order.map((id) => run.nodes[id]).filter(Boolean);
  const hasFinal = run.finalOutput !== undefined;
  const ctx = {
    workflow: `${run.workflowName} ${run.workflowVersion === 'draft' ? '(draft)' : `v${run.workflowVersion}`}`,
    status: run.status,
    jurisdiction: run.jurisdiction ? `${run.jurisdiction.value}${run.jurisdiction.assumed ? ' (assumed)' : ''}` : undefined,
    error: run.error?.message,
    final_output_node: hasFinal ? (run.finalNodeId ? run.nodes[run.finalNodeId]?.name : undefined) : undefined,
    final_output: hasFinal ? clipJson(run.finalOutput, 20_000) : undefined,
    nodes: nodes.map((n) => ({
      name: n.name,
      status: n.status,
      skill: n.skillName,
      // What the other finished steps produced (e.g. the numbered findings behind a written memo).
      output: n.status === 'succeeded' && n.output !== undefined && n.nodeId !== run.finalNodeId ? clipJson(n.output, 6_000) : undefined,
      error: n.error?.message,
      skipped: n.skipReason,
      grounding: n.validation?.grounding?.map((g) => `${g.label} ${g.passed}/${g.total}`),
      verification: n.verification?.items.map((v) => ({ finding: v.location, rule: v.ruleId, verdict: v.verdict, needs_priority_review: v.needsHumanReview, reason: v.reason })),
      approval: n.approval ? `${n.approval.decision} by ${n.approval.byName}${n.approval.comment ? `: ${n.approval.comment}` : ''}` : undefined,
    })),
    human_review: Object.entries(run.reviews ?? {}).map(([key, m]) => ({ finding: key.split('|')[1], node: run.nodes[key.split('|')[0]]?.name, decision: m.decision, by: m.byName, note: m.note, edits: m.edits })),
    missed_by_ai: (run.missed ?? []).map((m) => ({ rule: m.ruleId, issue: m.issue, quote: m.quote, by: m.byName })),
  };
  const s = JSON.stringify(ctx, null, 1);
  return s.length > CONTEXT_LIMIT ? `${s.slice(0, CONTEXT_LIMIT)}…（已截断）` : s;
}

/** The first document the run was given (the material the questions are usually about). */
export function primaryDocument(rt: Runtime, run: Run): MaterialDocument | undefined {
  for (const d of run.definition.inputs) {
    const id = run.documents[d.key];
    if (!id) continue;
    const doc = rt.db.documents.get(run.orgId, id);
    if (doc) return doc;
  }
  return undefined;
}

/** Earlier questions and answers about the same run (most recent last, capped). */
export function historyFor(conv: Conversation, runId: string, maxPairs = 4): string {
  const pairs: string[] = [];
  const msgs = conv.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'user' || m.mode !== 'ask' || m.runId !== runId) continue;
    const a = msgs.slice(i + 1).find((x) => x.role === 'assistant' && x.kind === 'answer' && x.runId === runId);
    if (a && a.role === 'assistant' && a.kind === 'answer') pairs.push(`Q: ${m.text}\nA: ${a.text.slice(0, 1500)}`);
  }
  return pairs.slice(-maxPairs).join('\n\n');
}

/** Follow-up answer through the normal skill pipeline (pseudonymisation, input fencing, leak scrubbing). */
export async function answerFollowUp(p: {
  rt: Runtime;
  org: Org;
  user: User;
  run: Run;
  question: string;
  history: string;
  showThinking?: boolean;
  onThinkingDelta?: (key: string, text: string) => void;
  signal?: AbortSignal;
}): Promise<SkillExecution> {
  const { rt, org, user, run } = p;
  const doc = primaryDocument(rt, run);
  return executeSkill({
    runtime: rt,
    org,
    skill: QA_SKILL,
    inputs: { question: p.question, run_result: runContextJson(run), history: p.history },
    documents: doc ? { material: doc } : {},
    rulePacks: Object.entries(run.rulePackContents ?? {}).map(([id, content]) => {
      const snap = run.rulePacks.find((r) => r.id === id);
      return { id, name: snap?.name ?? id, label: snap?.version === 'draft' ? 'draft — not reviewed' : `approved v${snap?.version}`, content };
    }),
    mode: run.mode === 'test' ? 'test' : 'production',
    jurisdiction: run.jurisdiction,
    // A chat answer cannot pause for a tool approval: "ask" tools are simply not used here.
    canUseTool: (tool) => {
      const d = decide(user, org.policy, `tool:${tool}`);
      return d === 'ask' ? 'deny' : d;
    },
    agent: RESULT_QA,
    showThinking: p.showThinking,
    onThinkingDelta: p.onThinkingDelta,
    signal: p.signal,
  });
}

/** The reasoning recorded for an answer ("深度思考"), main agent only. */
export function thinkingOf(exec: SkillExecution): string | undefined {
  const parts = exec.transcript.flatMap((e) => (e.type === 'thinking' && !e.agent ? [e.text] : []));
  return parts.length ? parts.join('\n\n').slice(0, 30_000) : undefined;
}

/**
 * Maps a chat message onto the workflow's inputs: attachments fill the document inputs in order; without
 * attachments the message text is the material (pasted text). Other inputs come from `params` or defaults.
 */
export function inputsFromChat(defs: InputField[], p: { text: string; attachments: ChatAttachment[]; params: Record<string, unknown> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const docDefs = defs.filter((d) => d.type === 'document');
  const textual = defs.filter((d) => d.type === 'long_text');
  for (const d of defs) {
    const v = p.params[d.key];
    if (v !== undefined && v !== null && v !== '') out[d.key] = v;
  }
  if (p.attachments.length) {
    docDefs.forEach((d, i) => {
      if (p.attachments[i] && out[d.key] === undefined) out[d.key] = { documentId: p.attachments[i].documentId };
    });
  } else if (p.text.trim()) {
    const target = docDefs.find((d) => out[d.key] === undefined) ?? textual.find((d) => out[d.key] === undefined);
    if (target) out[target.key] = p.text;
  }
  return out;
}

export function titleFrom(text: string, attachments: ChatAttachment[]): string {
  const base = attachments[0]?.filename ?? text.replace(/\s+/g, ' ').trim();
  if (!base) return DEFAULT_TITLE;
  return base.length > 28 ? `${base.slice(0, 27)}…` : base;
}

export function summarize(c: Conversation): ConversationSummary {
  const last = [...c.messages].reverse().find((m) => m.role === 'user' || (m.role === 'assistant' && m.kind !== 'run'));
  const lastText = (last ? ('text' in last ? last.text : '') : '').replace(/^[\s>#*-]+/, '');
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
    lastText: lastText.replace(/\s+/g, ' ').slice(0, 80) || undefined,
    runIds: c.messages.flatMap((m) => (m.role === 'assistant' && m.kind === 'run' ? [m.runId] : [])),
  };
}

/** The run a follow-up refers to: the one named, else the latest run in the conversation. */
export function targetRunId(c: Conversation, runId?: string): string | undefined {
  const runs = c.messages.flatMap((m) => (m.role === 'assistant' && m.kind === 'run' ? [m.runId] : []));
  if (runId) return runs.includes(runId) ? runId : undefined;
  return runs[runs.length - 1];
}

export type { ConversationMessage };
