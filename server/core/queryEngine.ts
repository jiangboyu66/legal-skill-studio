import { buildOutputSchema } from '../../shared/schema';
import type { AppErrorInfo, OutputField, PermissionEffect, TranscriptEntry, Usage } from '../../shared/types';
import { AppError, toErrorInfo } from '../errors';
import { completeWithRetry } from '../services/llm';
import { type Block, type ChatMessage, type CompletionResult, type LLMProvider, type MockHints, type SystemBlock, textOf, type ToolSchema } from '../services/llm/types';
import type { HookRunner } from './hooks';
import { extractJson, unwrapMarkdown } from './json';
import { repairMessage } from './prompt';
import { type Tool, type ToolContext, type ToolOutput, validateToolInput } from './tool';
import { SUBMIT_OUTPUT } from './tools';
import { validateOutput } from './validate';

export interface QueryEngineConfig {
  provider: LLMProvider;
  system: SystemBlock[];
  /** Tool pool for this agent (already filtered by agent allowlist and skill configuration). */
  tools: Tool[];
  toolContext: ToolContext;
  /** When set, the final answer must be structured and is collected through submit_output. */
  outputFields?: OutputField[];
  /** Tool protocol on/off (provider capability × AGENT_TOOLS feature). Off → JSON-in-text with one repair. */
  useTools: boolean;
  /** Injected permission check (deny / ask / allow) — cf. canUseTool in QueryEngineConfig. */
  canUseTool: (toolName: string) => PermissionEffect;
  grantedTools: string[];
  hooks?: HookRunner;
  maxTurns: number;
  maxTokens: number;
  retry: { maxRetries: number; baseMs: number };
  budgetUsd?: number;
  priceFn?: (u: Usage) => number | undefined;
  onTranscript?: (e: TranscriptEntry) => void;
  /** Applied to every transcript entry before it is recorded or streamed (e.g. to redact a leaked system prompt). */
  scrub?: (e: TranscriptEntry) => TranscriptEntry;
  hints?: MockHints;
}

export interface QueryResult {
  ok: boolean;
  output?: unknown;
  rawText?: string;
  transcript: TranscriptEntry[];
  usage: Usage;
  model?: string;
  turns: number;
  attempts: number;
  repaired: boolean;
  error?: AppErrorInfo;
  permissionRequest?: { tool: string; input: unknown; reason: string };
}

const SUBMIT_DESCRIPTION = [
  'Submits the final structured result of this skill. Call it exactly once, when you are done.',
  'The input must match the schema exactly (field names, required fields, enum values).',
  'If the result is rejected, the error lists what to fix — correct it and call submit_output again.',
].join('\n');

const clip = (v: unknown, n = 600) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : v;
};

/**
 * The agent main loop (cf. QueryEngine.submitMessage): build request → call model (with retry) →
 * handle text / tool_use blocks → permission check → PreToolUse hooks → execute → PostToolUse hooks →
 * tool_result → repeat until submit_output is accepted, a final text answer arrives, or limits are hit.
 * Tracks tokens/cost and enforces maxTurns and an optional budget.
 */
export class QueryEngine {
  private messages: ChatMessage[] = [];
  private transcript: TranscriptEntry[] = [];
  private usage: Usage = {};
  private attempts = 0;
  private turns = 0;
  private repaired = false;
  private model?: string;

  constructor(private cfg: QueryEngineConfig) {}

  async run(userContent: Block[]): Promise<QueryResult> {
    try {
      this.messages.push({ role: 'user', content: userContent });
      return this.cfg.useTools ? await this.toolLoop() : await this.textMode();
    } catch (err) {
      return this.result({ ok: false, error: toErrorInfo(err) });
    }
  }

  private emit(raw: TranscriptEntry) {
    const e = this.cfg.scrub ? this.cfg.scrub(raw) : raw;
    this.transcript.push(e);
    this.cfg.onTranscript?.(e);
  }

  private result(r: Partial<QueryResult> & { ok: boolean }): QueryResult {
    return { transcript: this.transcript, usage: this.usage, model: this.model, turns: this.turns, attempts: this.attempts, repaired: this.repaired, ...r };
  }

  private addUsage(u?: Usage) {
    if (!u) return;
    const add = (a?: number, b?: number) => (a ?? 0) + (b ?? 0) || undefined;
    this.usage = {
      inputTokens: add(this.usage.inputTokens, u.inputTokens),
      outputTokens: add(this.usage.outputTokens, u.outputTokens),
      cacheReadTokens: add(this.usage.cacheReadTokens, u.cacheReadTokens),
      cacheWriteTokens: add(this.usage.cacheWriteTokens, u.cacheWriteTokens),
    };
    const cost = this.cfg.priceFn?.(this.usage);
    if (cost !== undefined) this.usage.costUsd = cost;
  }

  private async call(tools?: ToolSchema[]): Promise<CompletionResult> {
    try {
      const { result, attempts } = await completeWithRetry(
        this.cfg.provider,
        { system: this.cfg.system, messages: this.messages, tools, maxTokens: this.cfg.maxTokens, wantJson: !!this.cfg.outputFields, hints: this.cfg.hints },
        this.cfg.retry,
      );
      this.attempts += attempts;
      this.model = result.model;
      this.addUsage(result.usage);
      if (result.stopReason === 'refusal') {
        throw new AppError('MODEL_REFUSED', '模型拒绝处理该请求。', { hint: '请检查材料或任务说明是否触发了模型的安全策略，必要时改写说明。' });
      }
      if (result.stopReason === 'max_tokens') {
        throw new AppError('OUTPUT_TRUNCATED', '模型输出达到最大长度被截断，结果不完整。', { hint: '可在 Skill 高级设置中调大“最大输出长度”，或精简输入/拆分任务。' });
      }
      if (this.cfg.budgetUsd && (this.usage.costUsd ?? 0) > this.cfg.budgetUsd) {
        throw new AppError('BUDGET_EXCEEDED', `本次运行的模型费用超过预算（${this.cfg.budgetUsd} 美元）。`, { hint: '可调高 RUN_BUDGET_USD，或精简材料后重试。' });
      }
      return result;
    } catch (err) {
      if (err instanceof AppError && err.attempts) this.attempts += err.attempts;
      throw err;
    }
  }

  private toolSchemas(): ToolSchema[] {
    const schemas = this.cfg.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    if (this.cfg.outputFields) schemas.push({ name: SUBMIT_OUTPUT, description: SUBMIT_DESCRIPTION, inputSchema: buildOutputSchema(this.cfg.outputFields) });
    return schemas;
  }

  private finalText(text: string) {
    const out = unwrapMarkdown(text);
    if (!out) throw new AppError('OUTPUT_EMPTY', '模型返回了空内容。', { hint: '请重新运行；若反复出现，请检查任务说明。' });
    return this.result({ ok: true, output: out, rawText: text });
  }

  private async toolLoop(): Promise<QueryResult> {
    const schemas = this.toolSchemas();
    const fields = this.cfg.outputFields;
    let invalid = 0;
    let nudges = 0;
    while (this.turns < this.cfg.maxTurns) {
      const turn = ++this.turns;
      const res = await this.call(schemas.length ? schemas : undefined);
      this.messages.push({ role: 'assistant', content: res.content, raw: res.raw });
      const text = textOf(res.content);
      if (text.trim()) this.emit({ type: 'assistant_text', turn, text: text.slice(0, 2000) });
      const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');

      if (!uses.length) {
        if (!fields) return this.finalText(text);
        const parsed = extractJson(text);
        if (parsed.ok) {
          const v = validateOutput(fields, parsed.value);
          if (!v.errors.length) return this.result({ ok: true, output: v.value, rawText: text });
        }
        if (++nudges > 2) {
          throw new AppError('OUTPUT_PARSE_ERROR', '模型没有通过 submit_output 提交有效的结构化结果。', { hint: '可重新运行；若反复出现，请在任务说明中强调输出要求。' });
        }
        this.repaired = true;
        this.emit({ type: 'note', turn, message: '模型未调用 submit_output，已提醒其提交结构化结果' });
        this.messages.push({ role: 'user', content: [{ type: 'text', text: 'Please submit your final result by calling the submit_output tool.' }] });
        continue;
      }

      const results: Block[] = [];
      let final: unknown;
      let done = false;
      for (const use of uses) {
        const reply = (content: string, isError = false) => results.push({ type: 'tool_result', toolUseId: use.id, content, isError });
        if (done) {
          reply('Ignored: output already submitted.');
          continue;
        }
        this.emit({ type: 'tool_call', turn, id: use.id, name: use.name, input: clip(use.input) });

        if (use.name === SUBMIT_OUTPUT && fields) {
          const v = validateOutput(fields, (use.input && typeof use.input === 'object' ? use.input : {}) as Record<string, unknown>);
          if (v.errors.length) {
            invalid++;
            this.repaired = true;
            reply(`Output rejected by schema validation:\n- ${v.errors.join('\n- ')}\nFix these problems and call submit_output again.`, true);
            this.emit({ type: 'tool_result', turn, id: use.id, name: use.name, ok: false, summary: `提交被拒：${v.errors[0]}` });
            if (invalid >= 3) {
              throw new AppError('OUTPUT_SCHEMA_ERROR', `模型输出不符合 Skill 定义的输出结构：${v.errors.slice(0, 3).join('；')}`, {
                hint: '可重新运行；或检查输出字段定义（必填项、可选值）是否过于严格。',
                details: { errors: v.errors },
              });
            }
            continue;
          }
          final = v.value;
          done = true;
          reply('Output accepted.');
          this.emit({ type: 'tool_result', turn, id: use.id, name: use.name, ok: true, summary: '结构化结果已提交并通过校验' });
          continue;
        }

        const tool = this.cfg.tools.find((t) => t.name === use.name);
        if (!tool) {
          reply(`ERROR: unknown tool "${use.name}". Available tools: ${schemas.map((s) => s.name).join(', ')}.`, true);
          this.emit({ type: 'tool_result', turn, id: use.id, name: use.name, ok: false, summary: '未知工具' });
          continue;
        }
        const decision = this.cfg.canUseTool(tool.name);
        const effective: PermissionEffect = decision === 'ask' && this.cfg.grantedTools.includes(tool.name) ? 'allow' : decision;
        if (effective !== 'allow') {
          this.emit({ type: 'permission', turn, tool: tool.name, decision: effective, reason: effective === 'ask' ? '组织策略要求人工确认' : '组织策略禁止' });
          if (effective === 'ask') {
            return this.result({
              ok: false,
              permissionRequest: { tool: tool.name, input: clip(use.input), reason: '组织策略要求人工确认后才能使用该工具' },
              error: { code: 'PERMISSION_REQUIRED', message: `AI 请求使用工具「${tool.name}」，按组织策略需要人工批准。` },
            });
          }
          reply(`ERROR: tool "${tool.name}" is not permitted by the organisation policy. Continue without it.`, true);
          continue;
        }
        const inputErrors = validateToolInput(tool, use.input);
        if (inputErrors.length) {
          reply(`ERROR: invalid input for ${tool.name}: ${inputErrors.join('; ')}`, true);
          this.emit({ type: 'tool_result', turn, id: use.id, name: tool.name, ok: false, summary: '工具参数无效' });
          continue;
        }
        const pre = await this.cfg.hooks?.run('PreToolUse', { tool: tool.name, input: use.input }, { matcher: tool.name, onNote: (e) => this.emit(e), turn });
        if (pre?.block) {
          reply(`ERROR: blocked by policy hook — ${pre.block}`, true);
          continue;
        }
        let out: ToolOutput;
        try {
          out = await tool.call(use.input as Record<string, unknown>, this.cfg.toolContext);
        } catch (e) {
          out = { content: `ERROR: ${(e as Error).message}`, summary: '工具执行出错', isError: true };
        }
        await this.cfg.hooks?.run('PostToolUse', { tool: tool.name, input: use.input, output: out }, { matcher: tool.name, onNote: (e) => this.emit(e), turn });
        reply(out.content, !!out.isError);
        this.emit({ type: 'tool_result', turn, id: use.id, name: tool.name, ok: !out.isError, summary: out.summary });
      }
      this.messages.push({ role: 'user', content: results });
      if (done) return this.result({ ok: true, output: final, rawText: JSON.stringify(final, null, 2) });
    }
    throw new AppError('MAX_TURNS', `模型在 ${this.cfg.maxTurns} 轮内没有完成任务。`, { hint: '可简化任务说明、减少需要的工具调用，或在 Skill 高级设置中调大最大轮次。' });
  }

  /** Fallback for providers without tool support: JSON in text, validated, with one repair round-trip. */
  private async textMode(): Promise<QueryResult> {
    const fields = this.cfg.outputFields;
    this.turns++;
    let res = await this.call();
    let text = textOf(res.content);
    this.messages.push({ role: 'assistant', content: res.content, raw: res.raw });
    if (!fields) return this.finalText(text);
    let parsed = extractJson(text);
    let checked = parsed.ok ? validateOutput(fields, parsed.value) : null;
    const problem = !parsed.ok ? parsed.error : checked?.errors.length ? checked.errors.join('；') : '';
    if (problem) {
      this.repaired = true;
      this.turns++;
      this.emit({ type: 'note', turn: this.turns, message: `输出不合规，已请模型修复：${problem.slice(0, 120)}` });
      this.messages.push({ role: 'user', content: [{ type: 'text', text: repairMessage(problem) }] });
      res = await this.call();
      text = textOf(res.content);
      parsed = extractJson(text);
      if (!parsed.ok) {
        throw new AppError('OUTPUT_PARSE_ERROR', `模型输出不是有效的 JSON，自动修复 1 次后仍失败（${parsed.error}）。`, { hint: '可重新运行；若反复出现，请在任务说明中强调输出格式。' });
      }
      checked = validateOutput(fields, parsed.value);
      if (checked.errors.length) {
        throw new AppError('OUTPUT_SCHEMA_ERROR', `模型输出不符合 Skill 定义的输出结构：${checked.errors.slice(0, 3).join('；')}`, { hint: '可重新运行；或检查输出字段定义。', details: { errors: checked.errors } });
      }
    }
    return this.result({ ok: true, output: checked!.value, rawText: text });
  }
}
