import type { OutputField } from '../../../shared/types';
import { AppError, Errors } from '../../errors';
import type { Block, CompletionRequest, CompletionResult, LLMProvider, MockHints } from './types';

/** Waits, but stops at once (RUN_CANCELED) when the run is stopped. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Errors.canceled());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Errors.canceled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Simulated reasoning for "深度思考" in mock mode — labelled, generic, derived from the request only. */
function mockThinking(h: MockHints | undefined, turn: number, keyword: string): string {
  if (!h) return '（模拟思考）没有上下文。';
  if (h.agentType === 'result-qa') {
    const q = (h.inputs.question ?? '').replace(/\s+/g, ' ').slice(0, 60);
    return `（模拟思考，非真实模型）用户问的是“${q}”。先看运行结果里的问题清单、结论核验和人工复核记录，再判断需不需要回到原文核对；只依据这些内容回答，拿不准就直说。`;
  }
  if (h.agentType === 'verifier') {
    return '（模拟思考，非真实模型）逐条核对：引用的规则是否存在、是否适用于这个投放渠道；引文是不是原文；结论有没有超出规则本身的要求，或者依赖材料里没有的事实。';
  }
  if (turn === 0) {
    return `（模拟思考，非真实模型）这一步是「${h.skillName}」。先通读材料，找出可能触发规则的表述${keyword ? `，例如“${keyword}”` : ''}；有把握之前先查规则全文或在材料里搜索原句，最后按要求的结构提交结果。`;
  }
  return '（模拟思考，非真实模型）工具结果已经返回，信息够了；按输出要求整理结果并提交。';
}

/** Phrases that typically trigger marketing-compliance issues; used only to make mock output plausible. */
const RED_FLAG = /\b(no\.?\s?1|best|guarantee[sd]?|clinically|cure[sd]?|risk-free|today only|lifetime|nric|free|100%|was \$)/i;
const STRONG = /\b(cure|clinically|nric|today only|guarantee)/i;

function splitSentences(text: string): string[] {
  return text
    .replace(/<\/?page[^>]*>/g, '\n')
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim().replace(/^[-*#>\s]+/, ''))
    .filter((s) => s.length >= 8 && s.length <= 300);
}

function primaryText(h: MockHints): string {
  const candidates = h.inputDefs.filter((d) => d.type !== 'text').map((d) => h.inputs[d.key] ?? '');
  const prose = candidates.filter((t) => !/^\s*[{[]/.test(t));
  return (prose.length ? prose : candidates).sort((a, b) => b.length - a.length)[0] ?? '';
}

function firstJsonArrayLength(h: MockHints): number | undefined {
  for (const v of Object.values(h.inputs)) {
    try {
      const p = JSON.parse(v);
      const arr = Array.isArray(p) ? p : Object.values(p ?? {}).find(Array.isArray);
      if (Array.isArray(arr)) return arr.length;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

class Generator {
  private sentences: string[];
  private flags: string[];
  readonly ids: string[];
  private listHint?: number;
  constructor(
    private h: MockHints,
    private fakeQuote = false,
  ) {
    const all = splitSentences(primaryText(h)).filter((s) => !s.includes('[[MOCK:'));
    this.flags = all.filter((s) => RED_FLAG.test(s));
    this.sentences = [...this.flags, ...all.filter((s) => !RED_FLAG.test(s))];
    this.ids = [...new Set(h.knowledge.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+)*-\d{1,3}[a-z]?\b/g) ?? [])];
    this.listHint = firstJsonArrayLength(h);
  }
  keyword() {
    return (this.flags[0] ?? this.sentences[0] ?? '').split(/\s+/).slice(0, 3).join(' ');
  }
  sentence(i: number) {
    // [[MOCK:FAKE_QUOTE]]: the first quote is invented (it does not appear in the material).
    if (this.fakeQuote && i === 0) return 'Voted the most trusted brand by 9 out of 10 local doctors in an independent survey';
    return this.sentences.length ? this.sentences[i % this.sentences.length] : '（模拟）未找到可引用的原文句子';
  }
  private overallRisk() {
    return this.flags.length >= 3 ? 'high' : this.flags.length ? 'medium' : 'low';
  }

  value(f: OutputField, i: number, inList: boolean): unknown {
    const key = f.key.toLowerCase();
    const label = f.label || f.key;
    switch (f.type) {
      case 'number':
        return key === 'index' ? i : i + 1;
      case 'boolean':
        return /need|require|human|review|missing/.test(key) ? STRONG.test(this.sentence(i)) || i % 3 === 0 : false;
      case 'enum': {
        const opts = (f.options ?? []).filter(Boolean);
        if (opts.includes('high') && opts.includes('low')) {
          if (!inList) return this.overallRisk();
          return STRONG.test(this.sentence(i)) ? 'high' : 'medium';
        }
        if (opts.includes('supported')) return i % 3 === 2 ? (opts.includes('needs_facts') ? 'needs_facts' : opts[0]) : 'supported';
        return opts.length ? opts[i % opts.length] : '';
      }
      case 'string_list':
        return /missing|facts/.test(key) && i % 3 !== 2 ? [] : [0, 1].map((j) => (/quote|evidence|excerpt/.test(key) ? this.sentence(i + j) : `[模拟] ${label} ${j + 1}`));
      case 'object_list': {
        const hasIndex = (f.fields ?? []).some((s) => s.key === 'index');
        const count = hasIndex && this.listHint !== undefined ? this.listHint : /findings|claims|issues/.test(key) ? this.flags.length : Math.max(1, Math.min(4, this.flags.length || 2));
        return Array.from({ length: count }, (_, j) => Object.fromEntries((f.fields ?? []).map((sf) => [sf.key, this.value(sf, j, true)])));
      }
      case 'string':
      default:
        if (/quote|evidence|excerpt|原文/.test(key)) return this.sentence(i);
        if (/rule|clause|citation/.test(key) && this.ids.length) return this.ids[i % this.ids.length];
        if (/summary|overview|摘要/.test(key)) return `[模拟] 材料中识别到 ${this.flags.length} 处需关注的表述，以下结果由模拟模式生成。`;
        return `[模拟] ${label}${i ? ` ${i + 1}` : ''}`;
    }
  }

  json(): Record<string, unknown> {
    return Object.fromEntries(this.h.fields.map((f) => [f.key, this.value(f, 0, false)]));
  }

  markdown(): string {
    const parts = ['> ⚠️ 模拟模式输出：未调用真实模型，以下内容由程序根据输入自动拼装，仅用于演示流程。', '', `## ${this.h.skillName}`, ''];
    for (const def of this.h.inputDefs) {
      const raw = this.h.inputs[def.key];
      if (!raw) continue;
      parts.push(`### 输入：${def.label}`);
      parts.push(tableFromJson(raw) ?? `> ${raw.replace(/<\/?page[^>]*>/g, ' ').slice(0, 300).replace(/\n+/g, ' ')}${raw.length > 300 ? '…' : ''}`, '');
    }
    parts.push('### 结论（模拟）', '', '- 请配置真实模型密钥后重新运行以获得实际分析结果。');
    return parts.join('\n');
  }
}

function cell(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80);
}

function tableFromJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (Object.values(parsed ?? {}).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object') as unknown[] | undefined);
    if (!arr || !arr.length || typeof arr[0] !== 'object') return null;
    const cols = Object.keys(arr[0] as object).slice(0, 5);
    const rows = arr.slice(0, 8).map((r) => `| ${cols.map((c) => cell((r as Record<string, unknown>)[c])).join(' | ')} |`);
    return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows].join('\n');
  } catch {
    return null;
  }
}

let seq = 0;
const toolUse = (name: string, input: unknown): Block => ({ type: 'tool_use', id: `toolu_mock_${++seq}`, name, input });

/**
 * Markers that reproduce failure modes in mock mode when they appear anywhere in a skill's inputs
 * (e.g. pasted into the material). They have no effect with a real model.
 */
export const MOCK_MARKERS = ['429', '429_ONCE', 'TIMEOUT', 'BAD_JSON', 'FAKE_QUOTE', 'LEAK'] as const;
export type MockMarker = (typeof MOCK_MARKERS)[number];

export function mockMarker(h: MockHints): MockMarker | undefined {
  const m = /\[\[MOCK:(429_ONCE|429|TIMEOUT|BAD_JSON|FAKE_QUOTE|LEAK)\]\]/i.exec(Object.values(h.inputs).join('\n'));
  return m ? (m[1].toUpperCase() as MockMarker) : undefined;
}

/**
 * Mock "skill-optimizer": keeps the current instructions and appends a short checklist built from the
 * rule IDs of missed issues in the evidence. Deterministic; it cannot actually improve mock results,
 * so in mock mode the gate is expected to reject the candidate (no holdout gain).
 */
function mockOptimizerCandidate(h: MockHints): Record<string, unknown> {
  const current = h.inputs.current_instructions ?? '';
  const rules = [...new Set([...(h.inputs.evidence ?? '').matchAll(/\[missed\][^\n]*acceptable rules: ([A-Z0-9-]+)/g)].map((m) => m[1]))].slice(0, 4);
  const checklist = rules.length ? `\n\n（模拟优化）复核清单：提交前逐一确认是否遗漏与 ${rules.join('、')} 相关的问题。` : '\n\n（模拟优化）提交前再逐句复查一次物料，确认没有遗漏。';
  const room = Math.max(0, Math.floor(current.length * 0.18));
  return {
    instructions: `${current}${checklist.slice(0, room)}`,
    rationale: '[模拟] 根据训练集漏检项追加复核清单；模拟模式下模型输出不随说明变化，预计无法通过门控。',
    changes: rules.length ? rules.map((r) => `[模拟] 追加 ${r} 相关的复核提示`) : ['[模拟] 追加通用复核提示'],
  };
}

const STATUS_ZH: Record<string, string> = { succeeded: '已完成', failed: '失败', rejected: '在审批节点被驳回', canceled: '已手动停止', running: '运行中', waiting_approval: '等待审批', queued: '排队中' };

/**
 * Mock "result-qa" (chat follow-up): restates the run result the agent was given, so the chat flow can be
 * demonstrated without a model. Clearly labelled; it does not analyse anything.
 */
export function mockQaAnswer(h: MockHints): string {
  const q = (h.inputs.question ?? '').replace(/\s+/g, ' ').trim();
  const lines = ['> ⚠️ 模拟模式回答：未调用真实模型，以下内容由程序根据运行结果拼装，仅用于演示对话流程。', '', `**你的问题**：${q.slice(0, 200)}`, ''];
  let data: { status?: string; error?: string; final_output?: unknown; final_output_node?: string; nodes?: { name?: string; output?: unknown }[]; human_review?: unknown[]; missed_by_ai?: unknown[] } | undefined;
  try {
    data = JSON.parse(h.inputs.run_result ?? '');
  } catch {
    data = undefined;
  }
  if (!data) return [...lines, '（无法读取运行结果。）'].join('\n');
  lines.push(`这次运行的状态：${STATUS_ZH[data.status ?? ''] ?? data.status ?? '未知'}${data.error ? `（${data.error}）` : ''}。`);
  const out = data.final_output;
  if (typeof out === 'string' && out.trim()) {
    const first = out.split('\n').map((l) => l.trim()).find((l) => l && !/^[>#|*-]/.test(l)) ?? '';
    lines.push('', `最终结果是${data.final_output_node ? `「${data.final_output_node}」生成的` : ''}一份文字报告（约 ${out.length} 字）${first ? `，开头：“${first.slice(0, 60)}”` : ''}。`);
  } else if (out === undefined || out === null) lines.push('', '这次运行没有最终结果。');
  // numbered findings: in the final result, or in the step that produced them
  const sources: [string | undefined, unknown][] = [[undefined, out], ...(data.nodes ?? []).map((n) => [n.name, n.output] as [string | undefined, unknown])];
  const lists = sources.flatMap(([from, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => Array.isArray(x) && x.length > 0 && typeof x[0] === 'object')
          .map(([key, x]) => ({ from, key, rows: x as Record<string, unknown>[] }))
      : [],
  );
  // prefer the findings / issues list over e.g. the extracted claims
  const found = lists.find((l) => /finding|issue|problem|risk/i.test(l.key)) ?? lists[0];
  if (found) {
    const rows = found.rows;
    const want = /#\s?(\d{1,3})|第\s?(\d{1,3})\s?[条项个]/.exec(q);
    const n = want ? Number(want[1] ?? want[2]) : 0;
    const show = n >= 1 && n <= rows.length ? [[n - 1, rows[n - 1]] as const] : rows.slice(0, 3).map((r, i) => [i, r] as const);
    lines.push('', `${found.from ? `「${found.from}」的结果` : '最终结果'}中有 ${rows.length} 条「${found.key}」${n ? `，你问到的是第 ${n} 条` : '，前几条是'}：`);
    for (const [i, row] of show) {
      const rule = Object.entries(row).find(([k]) => /rule|clause/i.test(k))?.[1];
      const quote = Object.entries(row).find(([k]) => /quote|evidence|excerpt/i.test(k))?.[1];
      const issue = Object.entries(row).find(([k]) => /issue|problem|finding|conclusion|reason|risk_description/i.test(k))?.[1];
      lines.push(`${i + 1}. ${rule ? `[${String(rule)}] ` : ''}${issue ? String(issue).slice(0, 120) : ''}${quote ? ` —— 原文：“${String(quote).slice(0, 80)}”` : ''}`);
    }
  } else if (out && typeof out === 'object') lines.push('', `最终结果：${JSON.stringify(out).slice(0, 300)}`);
  else if (data.status === 'succeeded') lines.push('', '各步骤都没有列出具体问题。');
  const reviewed = data.human_review?.length ?? 0;
  const missed = data.missed_by_ai?.length ?? 0;
  if (reviewed || missed) lines.push('', `人工复核记录：${reviewed} 条标记，${missed} 条补充的漏项。`);
  lines.push('', '配置真实模型密钥（如 DEEPSEEK_API_KEY）后，这里会结合运行结果、原始材料和规则包给出具体解释。');
  return lines.join('\n');
}

/** Appends `extra` to the first string value found (depth-first) — used by the LEAK marker. */
function appendToFirstString(v: unknown, extra: string): boolean {
  if (!v || typeof v !== 'object') return false;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'string') {
      (v as Record<string, unknown>)[k] = `${x} ${extra}`;
      return true;
    }
    if (x && typeof x === 'object' && appendToFirstString(x, extra)) return true;
  }
  return false;
}

/**
 * Deterministic offline provider that behaves like a small agent: for structured skills it makes one
 * exploratory tool call (rule lookup or document search) and then submits its output via submit_output.
 */
export class MockProvider implements LLMProvider {
  capabilities = { tools: true, vision: false, pdf: false, promptCache: false };
  private seen = new WeakSet<CompletionRequest>();
  constructor(private latencyMs = 500) {}

  info = { name: 'mock' as const, model: 'mock-legal-v2', mode: 'mock' as const, vision: false, thinking: true };

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (req.signal?.aborted) throw Errors.canceled();
    const h = req.hints;
    let reasoning: string | undefined;
    if (req.onThinking) {
      // "深度思考" in mock mode: stream a short, clearly labelled simulated reasoning
      const turnNow = req.messages.filter((m) => m.role === 'assistant').length;
      reasoning = mockThinking(h, turnNow, h ? new Generator(h).keyword() : '');
      const parts = reasoning.match(/[^，；。]+[，；。]?/g) ?? [reasoning];
      for (const p of parts) {
        await sleep(Math.min(80, Math.max(10, this.latencyMs / 8)), req.signal);
        req.onThinking(p);
      }
    }
    if (this.latencyMs > 0) await sleep(this.latencyMs * (0.6 + Math.random() * 0.8), req.signal);
    const tools = new Set((req.tools ?? []).map((t) => t.name));
    const turn = req.messages.filter((m) => m.role === 'assistant').length;
    const marker = h ? mockMarker(h) : undefined;
    const tag = '（模拟标记 [[MOCK:%s]]）';
    if (marker === '429' || (marker === '429_ONCE' && !this.seen.has(req))) {
      this.seen.add(req);
      throw new AppError('PROVIDER_RATE_LIMIT', `模型服务限流（HTTP 429），请求过于频繁。${tag.replace('%s', marker)}`, { hint: '系统已自动重试。请稍后再运行，或降低并发/升级额度。', retryable: true, retryAfterMs: 5 });
    }
    if (marker === 'TIMEOUT') {
      throw new AppError('PROVIDER_TIMEOUT', `模型调用超时。${tag.replace('%s', marker)}`, { hint: '系统已自动重试。可稍后再试、精简输入，或调大 LLM_TIMEOUT_MS。', retryable: true, retryAfterMs: 5 });
    }
    let content: Block[];
    if (!h) content = [{ type: 'text', text: '[模拟] 无上下文' }];
    else if (marker === 'BAD_JSON' && h.format === 'json') {
      content = tools.has('submit_output')
        ? [toolUse('submit_output', { unexpected: '模拟标记 [[MOCK:BAD_JSON]]：缺少必填字段' })]
        : [{ type: 'text', text: '抱歉，我无法按要求输出。（模拟标记 [[MOCK:BAD_JSON]]：非 JSON 内容）' }];
    } else {
      const g = new Generator(h, marker === 'FAKE_QUOTE');
      const leak = marker === 'LEAK' ? `（模拟泄露）${req.system[req.system.length - 1]?.text.replace(/\s+/g, ' ').slice(0, 400)}` : '';
      if (h.format === 'json') {
        const value = h.inputDefs.some((d) => d.key === 'current_instructions') ? mockOptimizerCandidate(h) : g.json();
        if (leak) appendToFirstString(value, leak);
        if (tools.has('submit_output')) {
          if (turn === 0 && tools.has('lookup_rule') && g.ids.length) content = [toolUse('lookup_rule', { rule_ids: g.ids.slice(0, 2) })];
          else if (turn === 0 && tools.has('search_document') && g.keyword()) content = [toolUse('search_document', { query: g.keyword() })];
          else content = [toolUse('submit_output', value)];
        } else content = [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      } else if (h.agentType === 'result-qa') content = [{ type: 'text', text: `${mockQaAnswer(h)}${leak ? `\n\n${leak}` : ''}` }];
      else content = [{ type: 'text', text: `${g.markdown()}${leak ? `\n\n${leak}` : ''}` }];
    }
    const chars = req.system.reduce((n, s) => n + s.text.length, 0) + JSON.stringify(req.messages).length;
    return {
      content,
      reasoning,
      model: this.info.model,
      usage: { inputTokens: Math.ceil(chars / 4), outputTokens: Math.ceil(JSON.stringify(content).length / 4) },
      stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end',
    };
  }
}
