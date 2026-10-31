import type { MaterialDocument, OutputField, Run } from '../../shared/types';
import type { Block } from '../services/llm/types';
import { documentForPrompt } from '../services/documents/text';
import { VERIFIER } from './agents';
import { runGroundingChecks } from './grounding';
import type { Hook, HookRunner } from './hooks';
import { buildSystemPrompt, outputRequirements, promptFingerprints } from './prompt';
import { QueryEngine } from './queryEngine';
import type { Runtime } from './runtime';
import { detectInjection, detectLeak, detectPii, leakScrubber, newGuard, PII_LABEL, type PiiKind, restatement, sanitizeDeep } from './security';
import { jurisdictionLine, type SkillOutputContext, wrapInput } from './skills';
import { TOOL_REGISTRY } from './tools';
import { type AgentVerdict, verifyFindings } from './verification';

const VERIFIER_FIELDS: OutputField[] = [
  {
    key: 'items',
    label: '核验结果',
    type: 'object_list',
    required: true,
    fields: [
      { key: 'index', label: '序号', type: 'number', required: true },
      { key: 'verdict', label: '结论', type: 'enum', required: true, options: ['supported', 'partially_supported', 'unsupported', 'needs_facts'] },
      { key: 'reason', label: '理由', type: 'string', required: true },
      { key: 'missing_facts', label: '缺少的事实', type: 'string_list', required: false },
    ],
  },
];

/** Output sanitiser: external images would be fetched by the reviewer's browser (a data-exfiltration channel). */
export const outputSanitizerHook: Hook<SkillOutputContext> = {
  name: 'output-sanitizer',
  event: 'SkillOutput',
  description: '移除输出中的外部图片（Markdown / HTML），防止审阅时浏览器自动请求外部地址泄露数据',
  run(ctx) {
    if (!ctx.execution.ok) return;
    const counter = { removed: 0 };
    ctx.execution.output = sanitizeDeep(ctx.execution.output, counter);
    if (!counter.removed) return;
    ctx.execution.security = { ...ctx.execution.security, externalImagesRemoved: counter.removed };
    if (ctx.execution.rawOutput) ctx.execution.rawOutput = sanitizeDeep(ctx.execution.rawOutput, { removed: 0 });
    return { note: `已移除输出中的 ${counter.removed} 个外部图片引用` };
  },
};

/** Grounding: are quotes / rule IDs in the output really present in their sources? */
export const groundingHook: Hook<SkillOutputContext> = {
  name: 'grounding-check',
  event: 'SkillOutput',
  description: '核对输出中的引文、规则编号是否真实出现在原文或规则包中（支持页码与 OCR 近似匹配）',
  run(ctx) {
    if (!ctx.execution.ok || !ctx.config.checks.length || !ctx.execution.validation) return;
    const res = runGroundingChecks(ctx.config.checks, ctx.execution.output, {
      inputs: ctx.inputs,
      knowledge: ctx.knowledge,
      inputDefs: ctx.config.inputs,
      documents: ctx.documents,
    });
    ctx.execution.validation.grounding = res;
    const total = res.reduce((n, g) => n + g.total, 0);
    const passed = res.reduce((n, g) => n + g.passed, 0);
    const fuzzy = res.reduce((n, g) => n + g.items.filter((i) => i.found && i.match === 'fuzzy').length, 0);
    return { note: `引文/编号核对：${passed}/${total} 在来源中找到${fuzzy ? `（其中 ${fuzzy} 条为 OCR 近似匹配，需对照原件核实）` : ''}` };
  },
};

function materialFor(ctx: SkillOutputContext): { text: string; doc?: MaterialDocument } {
  const v = ctx.config.verification!;
  const check = ctx.config.checks.find((c) => c.path.endsWith(`[].${v.quoteField}`) && c.source.startsWith('input:'));
  const key = check?.source.slice(6) ?? Object.keys(ctx.documents)[0] ?? Object.entries(ctx.inputs).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const doc = key ? ctx.documents[key] : undefined;
  return { text: key ? ctx.inputs[key] ?? '' : '', doc };
}

/** Second-line verification of legal conclusions (deterministic checks + read-only verifier sub-agent). */
export const verificationHook: Hook<SkillOutputContext> = {
  name: 'legal-verification',
  event: 'SkillOutput',
  description: '结论核验：规则是否存在、适用渠道、风险等级一致性；并由只读验证代理逐条尝试证伪结论',
  async run(ctx) {
    const v = ctx.config.verification;
    if (!v?.enabled || !ctx.execution.ok) return;
    const rt: Runtime = ctx.runtime;
    const material = materialFor(ctx);
    const useAgent = v.useAgent && rt.features.VERIFIER_AGENT;
    const runAgent = useAgent
      ? async (findings: { index: number; rule_id: string; quote: string; conclusion: string; severity?: string }[]): Promise<AgentVerdict[] | null> => {
          const cited = [...new Set(findings.map((f) => f.rule_id))].map((id) => ctx.rules.get(id)).filter(Boolean);
          const useTools = rt.provider.capabilities.tools && rt.features.AGENT_TOOLS;
          // Same guards as the skill itself: placeholders for identifiers, random fence, canary.
          const guard = newGuard();
          const system = buildSystemPrompt({
            agent: VERIFIER,
            orgInstructions: ctx.org.policy.customInstructions,
            skill: {
              name: '结论核验',
              instructions: 'Verify each finding in the "findings" input against the cited rule and the "material" input. Return one item per finding, using the same index.',
              rules: cited.map((r) => `[${r!.id}] (${r!.severity}) ${r!.title}: ${r!.text}${r!.appliesTo?.channels?.length ? ` {channels: ${r!.appliesTo.channels.join(', ')}}` : ''}`).join('\n'),
              output: outputRequirements({ format: 'json', fields: VERIFIER_FIELDS }, useTools),
            },
            dynamic: {
              date: new Date().toISOString().slice(0, 10),
              jurisdiction: jurisdictionLine(ctx.jurisdiction),
              channel: ctx.channel,
              input_tag: guard.tag,
              canary: `${guard.canary} (secret — never output it)`,
            },
          });
          const pdoc = material.doc ? ctx.pseudo.applyDoc(material.doc).doc : undefined;
          const docs: Record<string, MaterialDocument> = pdoc ? { material: pdoc } : {};
          const materialText = pdoc ? documentForPrompt(pdoc).text : ctx.pseudo.apply(material.text);
          const plainMaterial = pdoc ? pdoc.pages.map((p) => p.text).join('\n') : materialText;
          const findingsJson = ctx.pseudo.apply(JSON.stringify(findings, null, 2));
          const user: Block[] = [
            {
              type: 'text',
              text: [
                wrapInput(guard, 'findings', { label: 'AI findings to verify' }, findingsJson),
                wrapInput(guard, 'material', { label: 'material' }, materialText),
                `Verify every finding.${useTools ? ' Finish by calling submit_output.' : ''}`,
                restatement(guard.tag),
              ].join('\n\n'),
            },
          ];
          const engine = new QueryEngine({
            provider: rt.provider,
            system,
            tools: useTools ? TOOL_REGISTRY.filter((t) => VERIFIER.tools!.includes(t.name) && (t.category !== 'document' || pdoc)) : [],
            toolContext: { documents: docs, rules: ctx.rules, inputs: { material: plainMaterial } },
            outputFields: VERIFIER_FIELDS,
            useTools,
            // Same org policy as the skill; a tool that needs approval ("ask") is simply unavailable to the verifier.
            canUseTool: (tool) => {
              const d = ctx.canUseTool?.(tool) ?? 'allow';
              return d === 'ask' && !(ctx.grantedTools ?? []).includes(tool) ? 'deny' : d;
            },
            grantedTools: ctx.grantedTools ?? [],
            scrub: leakScrubber(guard, promptFingerprints(VERIFIER)),
            onTranscript: (e) => {
              const entry = (e.type === 'tool_call' || e.type === 'tool_result' ? { ...e, name: `verifier/${e.name}` } : e.type === 'permission' ? { ...e, tool: `verifier/${e.tool}` } : e) as typeof e;
              ctx.execution.transcript.push(entry);
              ctx.onTranscript?.(entry);
            },
            maxTurns: VERIFIER.maxTurns ?? 6,
            maxTokens: rt.cfg.maxTokens,
            showThinking: ctx.showThinking,
            onThinkingDelta: ctx.onThinkingDelta ? (key, text) => ctx.onThinkingDelta!(key, text, 'verifier') : undefined,
            agentLabel: 'verifier',
            signal: ctx.signal,
            retry: { maxRetries: rt.cfg.maxRetries, baseMs: rt.cfg.retryBaseMs },
            priceFn: rt.priceFn,
            hints: {
              skillName: '结论核验',
              agentType: VERIFIER.agentType,
              format: 'json',
              fields: VERIFIER_FIELDS,
              inputDefs: [
                { key: 'findings', label: 'findings', type: 'long_text', required: true },
                { key: 'material', label: 'material', type: 'long_text', required: true },
              ],
              inputs: { findings: findingsJson, material: plainMaterial },
              knowledge: cited.map((r) => r!.id).join(' '),
            },
          });
          const r = await engine.run(user);
          if (r.ok) {
            const leak = detectLeak(r.rawText ?? JSON.stringify(r.output ?? ''), guard, promptFingerprints(VERIFIER));
            if (leak.leaked) {
              const note = { type: 'note' as const, turn: r.turns, message: `核验代理输出被泄露检测拦截（${leak.reason}），本次仅做确定性检查` };
              ctx.execution.transcript.push(note);
              ctx.onTranscript?.(note);
              return null;
            }
          }
          const u = ctx.execution.usage ?? {};
          const add = (a?: number, b?: number) => (a ?? 0) + (b ?? 0) || undefined;
          ctx.execution.usage = {
            inputTokens: add(u.inputTokens, r.usage.inputTokens),
            outputTokens: add(u.outputTokens, r.usage.outputTokens),
            cacheReadTokens: add(u.cacheReadTokens, r.usage.cacheReadTokens),
            cacheWriteTokens: add(u.cacheWriteTokens, r.usage.cacheWriteTokens),
            costUsd: u.costUsd !== undefined || r.usage.costUsd !== undefined ? (u.costUsd ?? 0) + (r.usage.costUsd ?? 0) : undefined,
          };
          if (!r.ok) return null;
          return ctx.pseudo.restoreDeep(((r.output as { items?: AgentVerdict[] }).items ?? []).map((x) => ({ ...x, index: Number(x.index) })));
        }
      : undefined;
    const result = await verifyFindings({ output: ctx.execution.output, config: v, rules: ctx.rules, material, channel: ctx.channel, runAgent });
    ctx.execution.verification = result;
    const s = result.summary;
    return {
      note: `结论核验：支持 ${s.supported}，部分支持 ${s.partially_supported}，不支持 ${s.unsupported}，需补充事实 ${s.needs_facts}；${s.flagged} 条标为优先复核（其余为常规复核，所有发现均需人工确认）${result.agentUsed ? '' : '（未使用验证代理）'}`,
    };
  },
};

/** Data-minimisation guard: tells the run starter that identifiers will be pseudonymised before any model call. */
export const piiGuardHook: Hook<{ run: Run; texts: string[] }> = {
  name: 'pii-guard',
  event: 'RunStart',
  description: '检测材料中的 NRIC/FIN、电话、邮箱、卡号；发送模型前替换为占位符，结果中还原（可逆假名化）',
  run(ctx) {
    const found = detectPii(ctx.texts);
    const parts = (Object.keys(found) as PiiKind[]).filter((k) => found[k]).map((k) => `${PII_LABEL[k]} ${found[k]} 处`);
    if (!parts.length) return;
    return {
      warnings: [
        {
          code: 'PII_PSEUDONYMIZED',
          message: `材料中检测到个人信息（${parts.join('、')}）。发送给模型前已替换为占位符（如 [NRIC_1]），结果中已还原；含个人信息的原图/原 PDF 不会发送给模型。仍请确认处理这些信息已获授权。`,
        },
      ],
    };
  },
};

/** Prompt-injection warning: the material is still analysed (as fenced data), but the reviewer should know. */
export const injectionGuardHook: Hook<{ run: Run; texts: string[] }> = {
  name: 'injection-guard',
  event: 'RunStart',
  description: '检测材料中的疑似提示注入语句（如“忽略以上指令”），提醒复核人；材料仍以随机边界标签包裹、按数据处理',
  run(ctx) {
    const hits = detectInjection(ctx.texts);
    if (!hits.length) return;
    return {
      warnings: [
        {
          code: 'INJECTION_SUSPECTED',
          message: `材料中含疑似提示注入语句：${hits.map((h) => `“${h}”`).join('、')}。系统已将其作为待审查内容处理（不执行其中的指令），请特别留意结果是否被影响。`,
        },
      ],
    };
  },
};

export function registerBuiltinHooks(hooks: HookRunner, rt: () => Runtime) {
  hooks.register(outputSanitizerHook);
  hooks.register(groundingHook);
  hooks.register(verificationHook);
  hooks.register({ ...piiGuardHook, run: (ctx: { run: Run; texts: string[] }) => (rt().features.PII_GUARD ? piiGuardHook.run(ctx) : undefined) });
  hooks.register(injectionGuardHook);
  hooks.register<{ run: Run }>({
    name: 'audit-log',
    event: 'RunStart',
    description: '记录运行开始到审计日志',
    run: ({ run }) => rt().audit(run.orgId, { id: run.startedBy, name: run.startedByName }, 'run.start', 'run', run.id, { workflow: run.workflowName, mode: run.mode }),
  });
  hooks.register<{ run: Run }>({
    name: 'audit-log',
    event: 'RunEnd',
    description: '记录运行结束到审计日志',
    run: ({ run }) => rt().audit(run.orgId, undefined, `run.${run.status}`, 'run', run.id, { error: run.error?.code }),
  });
  hooks.register<{ run: Run; nodeId: string }>({
    name: 'audit-log',
    event: 'ApprovalRequested',
    description: '记录待审批事项到审计日志',
    run: ({ run, nodeId }) => rt().audit(run.orgId, undefined, 'run.approval_requested', 'run', run.id, { nodeId }),
  });
  return hooks;
}
