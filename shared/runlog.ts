import type { NodeRun, Run, RunLogEntry, RunLogKind, TranscriptEntry } from './types';

/**
 * Human-readable lines for a run's activity log ("运行过程"). Used by the engine while a run executes,
 * and to rebuild an approximate log for runs recorded before activity logs existed.
 */

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function toolText(name: string, input: unknown): string {
  const verifier = name.startsWith('verifier/');
  const tool = verifier ? name.slice('verifier/'.length) : name;
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  let what: string;
  switch (tool) {
    case 'read_document': {
      const range = i.from_page ? (i.to_page && i.to_page !== i.from_page ? `第 ${i.from_page}–${i.to_page} 页` : `第 ${i.from_page} 页`) : '全文';
      what = `读取材料${i.input_key ? `「${str(i.input_key)}」` : ''}${range}`;
      break;
    }
    case 'search_document':
      what = `在材料中搜索“${clip(str(i.query), 40)}”`;
      break;
    case 'lookup_rule':
      what = `查阅规则 ${Array.isArray(i.rule_ids) ? i.rule_ids.join('、') : str(i.rule_ids)}`;
      break;
    case 'verify_quote':
      what = `核对引文“${clip(str(i.quote), 40)}”`;
      break;
    case 'submit_output':
      what = '提交结构化结果';
      break;
    default:
      what = `调用工具 ${tool} ${clip(JSON.stringify(input ?? {}), 80)}`;
  }
  return verifier ? `核验代理：${what}` : what;
}

/** A transcript entry as a log line (kind, text); undefined when it adds nothing to the progress view. */
export function transcriptLine(e: TranscriptEntry): { kind: RunLogKind; text: string; detail?: string } | undefined {
  switch (e.type) {
    case 'tool_call':
      return { kind: 'tool', text: toolText(e.name, e.input) };
    case 'tool_result':
      if (e.name === 'submit_output' || e.name === 'verifier/submit_output') return e.ok ? undefined : { kind: 'error', text: `结构化结果未通过校验，已退回模型修正：${clip(e.summary, 120)}` };
      return { kind: e.ok ? 'result' : 'error', text: `${e.ok ? '→' : '✗'} ${clip(e.summary, 140)}`, detail: e.summary.length > 140 ? e.summary : undefined };
    case 'assistant_text':
      return { kind: 'model', text: `模型：${clip(e.text, 140)}`, detail: e.text.length > 140 ? e.text : undefined };
    case 'permission':
      return { kind: e.decision === 'allow' ? 'note' : 'approval', text: `工具 ${e.tool}：${e.decision === 'ask' ? '需要人工批准' : e.decision === 'deny' ? '被组织策略禁止' : '已允许'}${e.reason ? `（${clip(e.reason, 80)}）` : ''}` };
    case 'hook':
      return { kind: 'note', text: `${e.hook}：${clip(e.message, 140)}` };
    case 'note':
      return { kind: /失败|拦截|错误/.test(e.message) ? 'error' : 'note', text: clip(e.message, 160), detail: e.message.length > 160 ? e.message : undefined };
    case 'thinking': {
      const who = e.agent === 'verifier' ? '核验代理思考' : '思考';
      return { kind: 'thinking', text: `${who}：${clip(e.text, 160)}`, detail: e.text.length > 160 ? e.text.slice(0, 4000) + (e.text.length > 4000 ? '…（完整内容见节点的“AI 过程”）' : '') : undefined };
    }
  }
}

const secs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Summary line for a finished skill node. */
export function nodeDoneLine(nr: NodeRun): string {
  const parts = [`节点「${nr.name}」完成`];
  if (nr.latencyMs !== undefined) parts.push(`用时 ${secs(nr.latencyMs)}`);
  if (nr.turns) parts.push(`${nr.turns} 轮`);
  if (nr.attempts && nr.attempts > 1) parts.push(`调用模型 ${nr.attempts} 次`);
  for (const g of nr.validation?.grounding ?? []) if (!g.note) parts.push(`${g.label} ${g.passed}/${g.total}`);
  if (nr.verification) parts.push(`结论核验：${nr.verification.summary.flagged} 条优先复核 / 共 ${nr.verification.items.length} 条`);
  const out = nr.output;
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const lists = Object.entries(out as Record<string, unknown>).filter(([, v]) => Array.isArray(v));
    if (lists.length) {
      const [k, v] = lists.sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length)[0];
      const label = nr.outputFields?.find((f) => f.key === k)?.label ?? k;
      parts.push(`${label} ${(v as unknown[]).length} 项`);
    }
  } else if (typeof out === 'string' && out) parts.push(`输出 ${out.length} 字`);
  return parts.join('，');
}

/**
 * Rebuilds an approximate activity log for runs recorded before logs existed: node start / finish times
 * are real, transcript entries (which carry no time) are spread evenly in between.
 */
export function deriveLog(run: Run): RunLogEntry[] {
  const out: Omit<RunLogEntry, 'seq'>[] = [];
  const t0 = run.startedAt ?? run.createdAt;
  out.push({ at: run.createdAt, kind: 'run', status: 'queued', text: `运行已创建：工作流「${run.workflowName}」${run.workflowVersion === 'draft' ? '草稿' : `v${run.workflowVersion}`}，${run.mode === 'production' ? '正式运行' : '测试运行'}`, approx: true });
  out.push({ at: t0, kind: 'run', status: 'running', text: '开始执行', approx: true });
  for (const id of run.order) {
    const nr = run.nodes[id];
    if (!nr) continue;
    const start = nr.startedAt;
    const end = nr.finishedAt ?? (nr.status === 'skipped' ? start ?? run.finishedAt : undefined);
    if (nr.status === 'skipped') {
      out.push({ at: end ?? run.finishedAt ?? t0, kind: 'node', nodeId: id, status: 'skipped', text: `节点「${nr.name}」跳过：${nr.skipReason ?? ''}`, approx: true });
      continue;
    }
    if (!start) continue;
    if (nr.reusedFrom) {
      out.push({ at: start, kind: 'node', nodeId: id, status: 'succeeded', text: `节点「${nr.name}」复用 ${nr.reusedFrom} 的结果`, approx: true });
      continue;
    }
    out.push({ at: start, kind: 'node', nodeId: id, status: nr.type === 'approval' ? 'waiting_approval' : 'running', text: nr.type === 'approval' ? `等待审批：「${nr.name}」` : `节点「${nr.name}」开始（Skill「${nr.skillName ?? ''}」）`, approx: true });
    const lines = (nr.transcript ?? []).map(transcriptLine).filter((x): x is NonNullable<ReturnType<typeof transcriptLine>> => !!x);
    const a = Date.parse(start);
    const b = end ? Date.parse(end) : a;
    lines.forEach((l, i) => out.push({ at: new Date(a + ((b - a) * (i + 1)) / (lines.length + 1)).toISOString(), kind: l.kind, nodeId: id, text: l.text, detail: l.detail, approx: true }));
    if (nr.type === 'approval' && nr.approval) {
      out.push({ at: nr.approval.at, kind: 'approval', nodeId: id, status: nr.status, text: `${nr.approval.byName} ${nr.approval.decision === 'approved' ? '批准' : '驳回'}了「${nr.name}」${nr.approval.comment ? `：${clip(nr.approval.comment, 80)}` : ''}`, approx: true });
    } else if (nr.status === 'succeeded') out.push({ at: end ?? start, kind: 'node', nodeId: id, status: 'succeeded', text: nodeDoneLine(nr), approx: true });
    else if (nr.status === 'failed') out.push({ at: end ?? run.finishedAt ?? start, kind: 'error', nodeId: id, status: 'failed', text: `节点「${nr.name}」失败：${nr.error?.message ?? ''}`, approx: true });
  }
  if (run.finishedAt) out.push({ at: run.finishedAt, kind: 'run', status: run.status, text: runEndLine(run), approx: true });
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).map((e, i) => ({ ...e, seq: i + 1 }));
}

export function runEndLine(run: Run): string {
  const ms = run.finishedAt && (run.startedAt ?? run.createdAt) ? Date.parse(run.finishedAt) - Date.parse(run.startedAt ?? run.createdAt) : undefined;
  const label =
    { succeeded: '运行完成', failed: '运行失败', rejected: '运行在审批节点被驳回', canceled: `运行已停止${run.canceled ? `（${run.canceled.byName}）` : ''}` }[run.status as 'succeeded' | 'failed' | 'rejected' | 'canceled'] ?? '运行结束';
  const tokens = run.usage.inputTokens !== undefined ? `，token ${run.usage.inputTokens}/${run.usage.outputTokens ?? 0}` : '';
  return `${label}${ms !== undefined ? `，总用时 ${secs(ms)}` : ''}${tokens}${run.status === 'failed' && run.error ? `：${run.error.message}` : ''}`;
}

/** The log to show: the recorded one, or a rebuilt approximation for older runs. */
export const runLog = (run: Run): RunLogEntry[] => (run.log?.length ? run.log : deriveLog(run));
