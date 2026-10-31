import type { FaultType, InputField, Jurisdiction, MaterialDocument, Org, PermissionEffect, Rule, RulePackContent, SecurityReport, SkillConfig, SkillExecution, TranscriptEntry } from '../../shared/types';
import { AppError, Errors, toErrorInfo } from '../errors';
import { FaultInjectingProvider } from '../services/llm';
import type { Block } from '../services/llm/types';
import { documentForPrompt, paginate } from '../services/documents/text';
import { type AgentDefinition, SKILL_RUNNER } from './agents';
import { buildSystemPrompt, outputRequirements, promptFingerprints, renderPrompt, rulePacksText } from './prompt';
import { QueryEngine } from './queryEngine';
import type { Runtime } from './runtime';
import { detectInjection, detectLeak, fence, type Guard, leakScrubber, newGuard, Pseudonymizer, restatement } from './security';
import { TOOL_REGISTRY } from './tools';

export const MAX_INPUT_CHARS = 200_000;

export interface PackForRun {
  id: string;
  name: string;
  /** e.g. "approved v2 by …" or "draft (unreviewed)" */
  label: string;
  content: RulePackContent;
}

export interface ExecuteSkillParams {
  runtime: Runtime;
  org: Org;
  skill: { id: string; name: string; config: SkillConfig };
  /** raw string values per skill input key */
  inputs: Record<string, string>;
  /** document-backed inputs (input key -> document) */
  documents: Record<string, MaterialDocument>;
  rulePacks: PackForRun[];
  mode: 'test' | 'production';
  channel?: string;
  jurisdiction?: Jurisdiction;
  canUseTool?: (tool: string) => PermissionEffect;
  grantedTools?: string[];
  fault?: FaultType;
  onTranscript?: (e: TranscriptEntry) => void;
  /** Agent definition to run the skill with (default: skill-runner). */
  agent?: AgentDefinition;
}

/** Context handed to SkillOutput hooks (grounding checks, legal verification). */
export interface SkillOutputContext {
  runtime: Runtime;
  org: Org;
  config: SkillConfig;
  /** Original (restored) inputs and documents — grounding checks run against these. */
  inputs: Record<string, string>;
  documents: Record<string, MaterialDocument>;
  rules: Map<string, Rule & { packName: string }>;
  knowledge: string;
  channel?: string;
  jurisdiction?: Jurisdiction;
  execution: SkillExecution;
  /** The execution's pseudonymiser: hooks that call a model must apply it to anything they send. */
  pseudo: Pseudonymizer;
  canUseTool?: (tool: string) => PermissionEffect;
  grantedTools?: string[];
  onTranscript?: (e: TranscriptEntry) => void;
}

export function jurisdictionLine(j?: Jurisdiction): string | undefined {
  if (!j) return undefined;
  return j.assumed ? `${j.value} (ASSUMED — not confirmed by the user; ${j.source}). State this assumption where it matters.` : `${j.value} (specified by the user)`;
}

function ephemeralDoc(orgId: string, key: string, text: string): MaterialDocument {
  return {
    id: `inline_${key}`,
    orgId,
    filename: `${key}.txt`,
    mime: 'text/plain',
    kind: 'text',
    size: text.length,
    sha256: '',
    status: 'ready',
    method: 'plain',
    pages: paginate(text),
    warnings: [],
    uploadedBy: '',
    createdAt: new Date().toISOString(),
  };
}

/** Applies defaults, checks required inputs and size limits; turns pasted text for document inputs into inline documents. */
export function prepareInputs(orgId: string, defs: InputField[], raw: Record<string, unknown>, docs: Record<string, MaterialDocument>) {
  const inputs: Record<string, string> = {};
  const documents: Record<string, MaterialDocument> = {};
  const missing: { key: string; label: string }[] = [];
  for (const def of defs) {
    const given = raw[def.key];
    let value = typeof given === 'string' ? given : given == null ? '' : JSON.stringify(given);
    if (docs[def.key]) documents[def.key] = docs[def.key];
    else if (def.type === 'document' && value.trim()) documents[def.key] = ephemeralDoc(orgId, def.key, value);
    if (!documents[def.key] && !value.trim() && def.defaultValue) value = def.defaultValue;
    if (def.required && !documents[def.key] && !value.trim()) missing.push({ key: def.key, label: def.label || def.key });
    if (value.length > MAX_INPUT_CHARS) throw Errors.inputTooLong(def.label || def.key, MAX_INPUT_CHARS);
    inputs[def.key] = documents[def.key] ? documents[def.key].pages.map((p) => p.text).join('\n\n') : value;
  }
  if (missing.length) throw Errors.missingInputs(missing);
  return { inputs, documents };
}

export function rulesMap(packs: PackForRun[]) {
  const m = new Map<string, Rule & { packName: string }>();
  for (const p of packs) for (const r of p.content.rules) m.set(r.id, { ...r, packName: p.name });
  return m;
}

const attr = (v: string) => v.replace(/"/g, "'");

/** Wraps untrusted material in the execution's random boundary tag. */
export function wrapInput(guard: Guard, name: string, attrs: Record<string, string | number | undefined>, body: string): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${attr(String(v))}"`)
    .join('');
  return `<${guard.tag} name="${attr(name)}"${a}>\n${fence(body, guard.tag)}\n</${guard.tag}>`;
}

/**
 * Executes one skill as a sub-agent (SkillTool → AgentTool semantics):
 * pre-step guards (pseudonymisation, random boundary, canary) → layered system prompt + tool pool +
 * QueryEngine loop → post-step guards (leak check, restore placeholders) → SkillOutput hooks.
 */
export async function executeSkill(p: ExecuteSkillParams): Promise<SkillExecution> {
  const started = Date.now();
  const { runtime, org, skill } = p;
  const cfg = skill.config;
  const emptyPrompt = { system: '', user: '' };
  try {
    const { inputs, documents } = prepareInputs(org.id, cfg.inputs, p.inputs, p.documents);
    const rules = rulesMap(p.rulePacks);
    const knowledge = [cfg.knowledge, rulePacksText(p.rulePacks)].filter((s) => s?.trim()).join('\n\n');
    const agent = p.agent ?? SKILL_RUNNER;
    const useTools = runtime.provider.capabilities.tools && runtime.features.AGENT_TOOLS;
    const hasDocs = Object.keys(documents).length > 0;
    const pool = useTools
      ? TOOL_REGISTRY.filter(
          (t) =>
            cfg.tools.includes(t.name) &&
            (!agent.tools || agent.tools.includes(t.name)) &&
            (t.category !== 'document' || hasDocs) &&
            (t.name !== 'lookup_rule' || rules.size > 0),
        )
      : [];

    // ── pre-step guards: what the model sees is pseudonymised and fenced ──
    const guard = newGuard();
    const pseudo = new Pseudonymizer(runtime.features.PII_GUARD);
    const security: SecurityReport = { inputTag: guard.tag };
    const modelInputs: Record<string, string> = {};
    const modelDocs: Record<string, MaterialDocument> = {};
    const docHits: Record<string, number> = {};
    for (const def of cfg.inputs) {
      const doc = documents[def.key];
      if (doc) {
        const r = pseudo.applyDoc(doc);
        modelDocs[def.key] = r.doc;
        docHits[def.key] = r.hits;
        modelInputs[def.key] = r.doc.pages.map((x) => x.text).join('\n\n');
      } else modelInputs[def.key] = pseudo.apply(inputs[def.key] ?? '');
    }
    if (pseudo.total) {
      security.pseudonymized = pseudo.summary();
      security.pseudonymizedCount = pseudo.distinct;
    }
    const injection = detectInjection(Object.values(inputs));
    if (injection.length) security.injectionSuspected = injection;

    const system = buildSystemPrompt({
      agent,
      orgInstructions: org.policy.customInstructions,
      skill: {
        name: skill.name,
        instructions: cfg.instructions,
        notes: cfg.knowledge,
        rules: rulePacksText(p.rulePacks),
        output: outputRequirements(cfg.output, useTools),
      },
      dynamic: {
        date: new Date().toISOString().slice(0, 10),
        mode: p.mode === 'test' ? 'test run (draft configuration)' : 'production run (published configuration)',
        jurisdiction: jurisdictionLine(p.jurisdiction),
        channel: p.channel,
        available_tools: pool.map((t) => t.name).join(', ') || 'none',
        input_tag: guard.tag,
        canary: `${guard.canary} (secret — never output it)`,
      },
      append: p.mode === 'test' ? 'This is a test run of an unpublished configuration; results are for the skill builder.' : undefined,
    });

    // User turn: (vision attachments) + inputs as fenced data blocks + the task + a restated policy.
    const blocks: Block[] = [];
    const parts: string[] = [];
    for (const def of cfg.inputs) {
      const doc = modelDocs[def.key];
      if (doc) {
        const r = documentForPrompt(doc);
        const conf = doc.pages.find((x) => x.ocrConfidence !== undefined)?.ocrConfidence;
        // Platform notes about the extraction stay OUTSIDE the untrusted block, so they are not mistaken for material.
        const notes = [r.truncated ? 'The document was truncated in this message; use read_document for the remaining pages.' : '', ...doc.warnings].filter(Boolean);
        parts.push(wrapInput(guard, def.key, { label: def.label, type: 'document', filename: doc.filename, extraction: doc.method, pages: doc.pages.length, ocr_confidence: conf }, r.text));
        if (notes.length) parts.push(`Platform notes on the "${def.key}" input: ${notes.join(' ')}`);
        const canSee = runtime.features.VISION && runtime.provider.capabilities.vision && (doc.kind === 'image' || (doc.kind === 'pdf' && runtime.provider.capabilities.pdf));
        if (canSee && docHits[def.key]) {
          // The original image/PDF would carry the identifiers we just replaced — send text only.
          (security.visionWithheld ??= []).push(doc.filename);
          continue;
        }
        const bytes = canSee ? runtime.readFile(documents[def.key]) : undefined;
        if (bytes && doc.kind === 'image') blocks.push({ type: 'image', mediaType: doc.mime, dataBase64: bytes.toString('base64') });
        if (bytes && doc.kind === 'pdf' && bytes.length < 20_000_000) blocks.push({ type: 'document', mediaType: 'application/pdf', dataBase64: bytes.toString('base64') });
      } else {
        parts.push(wrapInput(guard, def.key, { label: def.label }, modelInputs[def.key].trim() ? modelInputs[def.key] : '(empty)'));
      }
    }
    if (blocks.length) parts.unshift('The attached image/PDF is the original material; the text below was extracted from it. Use the original to judge layout and prominence (e.g. small print).');
    if (security.visionWithheld) parts.unshift('Note: the original file was not attached because it contains personal identifiers; work from the extracted text (layout and font size cannot be judged — say so if it matters).');
    parts.push(`Carry out the task described in the system prompt on the inputs above.${cfg.output.format === 'json' && useTools ? ' Finish by calling submit_output.' : ''}`);
    parts.push(restatement(guard.tag));
    const userText = parts.join('\n\n');
    blocks.push({ type: 'text', text: userText });

    const notes: TranscriptEntry[] = [];
    if (security.pseudonymized) notes.push({ type: 'note', turn: 0, message: `发送模型前已将个人信息替换为占位符：${security.pseudonymized}${security.visionWithheld ? '；含个人信息的原图/原 PDF 未发送给模型' : ''}` });
    if (security.injectionSuspected) notes.push({ type: 'note', turn: 0, message: `材料中含疑似提示注入语句（${security.injectionSuspected.map((s) => `“${s}”`).join('、')}），已作为数据处理（随机边界标签 + 结尾重申）` });
    for (const n of notes) p.onTranscript?.(n);

    const provider = p.fault && p.fault !== 'none' ? new FaultInjectingProvider(runtime.provider, p.fault) : runtime.provider;
    const engine = new QueryEngine({
      provider,
      system,
      tools: pool,
      toolContext: { documents: modelDocs, rules, inputs: modelInputs, outputFields: cfg.output.fields },
      outputFields: cfg.output.format === 'json' ? cfg.output.fields : undefined,
      useTools,
      canUseTool: p.canUseTool ?? (() => 'allow'),
      grantedTools: p.grantedTools ?? [],
      hooks: runtime.hooks,
      maxTurns: cfg.maxTurns ?? agent.maxTurns ?? runtime.cfg.maxTurns,
      maxTokens: cfg.maxTokens ?? runtime.cfg.maxTokens,
      retry: { maxRetries: runtime.cfg.maxRetries, baseMs: runtime.cfg.retryBaseMs },
      budgetUsd: runtime.cfg.budgetUsdPerRun || undefined,
      priceFn: runtime.priceFn,
      onTranscript: p.onTranscript,
      scrub: leakScrubber(guard, promptFingerprints(agent)),
      hints: { skillName: skill.name, agentType: agent.agentType, format: cfg.output.format, fields: cfg.output.fields, inputDefs: cfg.inputs, inputs: modelInputs, knowledge },
    });
    const r = await engine.run(blocks);
    const execution: SkillExecution = {
      ok: r.ok,
      output: r.output,
      rawOutput: r.rawText,
      validation: { schemaErrors: [], repaired: r.repaired, grounding: [] },
      security,
      prompt: renderPrompt(system, userText),
      transcript: [...notes, ...r.transcript],
      usage: r.usage,
      model: r.model,
      turns: r.turns,
      attempts: r.attempts,
      latencyMs: 0,
      error: r.error,
      permissionRequest: r.permissionRequest,
    };
    if (r.ok) {
      // ── post-step guards: leak check on what the model produced, then restore placeholders ──
      const raw = r.rawText ?? (typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? ''));
      const leak = detectLeak(raw, guard, promptFingerprints(agent));
      if (leak.leaked) {
        security.leakBlocked = leak.reason;
        execution.ok = false;
        execution.output = undefined;
        execution.rawOutput = '[已拦截：输出疑似泄露系统提示词，原文不予保存]';
        execution.error = new AppError('POLICY_BLOCKED', `输出被安全策略拦截：${leak.reason}。`, {
          hint: '这通常说明材料中含有提示注入内容。请检查材料来源；如确认无害，可删去可疑语句后重新运行。',
        }).toInfo();
        const note: TranscriptEntry = { type: 'note', turn: r.turns, message: `泄露检测：${leak.reason}，输出已拦截` };
        execution.transcript.push(note);
        p.onTranscript?.(note);
      } else {
        execution.output = pseudo.restoreDeep(r.output);
        execution.rawOutput = r.rawText === undefined ? undefined : pseudo.restore(r.rawText);
        const ctx: SkillOutputContext = {
          runtime, org, config: cfg, inputs, documents, rules, knowledge, channel: p.channel, jurisdiction: p.jurisdiction,
          execution, pseudo, canUseTool: p.canUseTool, grantedTools: p.grantedTools, onTranscript: p.onTranscript,
        };
        await runtime.hooks.run('SkillOutput', ctx, {
          onNote: (e) => {
            execution.transcript.push(e);
            p.onTranscript?.(e);
          },
          turn: r.turns,
        });
      }
    }
    execution.latencyMs = Date.now() - started;
    return execution;
  } catch (err) {
    return {
      ok: false,
      prompt: emptyPrompt,
      transcript: [],
      turns: 0,
      attempts: err instanceof AppError ? err.attempts ?? 0 : 0,
      latencyMs: Date.now() - started,
      error: toErrorInfo(err),
    };
  }
}
