import { buildOutputSchema, describeFields } from '../../shared/schema';
import type { OutputSpec, PromptRecord, RulePackContent } from '../../shared/types';
import type { SystemBlock } from '../services/llm/types';
import type { AgentDefinition } from './agents';
import { PLATFORM_SECURITY_RULES } from './security';

/**
 * Layered system prompt (cf. buildEffectiveSystemPrompt + SYSTEM_PROMPT_DYNAMIC_BOUNDARY):
 *   L0 platform (+ security rules)  →  L1 agent  →  L2 organisation  →  L3 skill (instructions, rules, output contract)
 *   ── dynamic boundary ──  L4 run context (date, mode, channel, jurisdiction, input tag, canary …) + append
 * Everything before the boundary is static for a given skill version and is marked cacheable.
 */
export const PLATFORM_PROMPT = `You are an assistant inside Legal Skill Studio, a platform where in-house legal and compliance teams run reusable skills and workflows on marketing and legal materials. Follow the layered instructions below. Organisation instructions refine, and never override, the platform and agent rules.\n\n${PLATFORM_SECURITY_RULES}`;

/** Fragments of static prompts that must never appear in outputs (leak detection). */
export function promptFingerprints(agent: AgentDefinition): string[] {
  return [PLATFORM_PROMPT.slice(0, 60), PLATFORM_SECURITY_RULES.split('\n')[1].slice(2, 70), agent.prompt.trim().slice(0, 60)].filter((s) => s.length >= 40);
}

export const DYNAMIC_BOUNDARY = '──── 动态内容边界（以上可缓存，以下每次运行不同）────';

export function outputRequirements(output: OutputSpec, useTool: boolean): string {
  if (output.format === 'json') {
    const guide = ['Field guide:', ...describeFields(output.fields)].join('\n');
    if (useTool) {
      return `When you are done, call the submit_output tool exactly once with an object that matches its input schema. Do not put the final result in plain text. If submit_output returns errors, fix them and call it again.\n\n${guide}`;
    }
    return [
      'Respond with ONE JSON object only — no Markdown code fences and no text before or after it.',
      'The object must validate against this JSON Schema:',
      JSON.stringify(buildOutputSchema(output.fields), null, 2),
      '',
      guide,
    ].join('\n');
  }
  return 'Respond in Markdown (headings, lists and tables are welcome). Do not wrap the whole answer in a code fence.';
}

export function rulePacksText(packs: { name: string; label: string; content: RulePackContent }[]): string {
  return packs
    .map(
      (p) =>
        `<rule_pack name="${p.name}" status="${p.label}">\n${p.content.rules
          .map((r) => `[${r.id}] (${r.severity}) ${r.title}: ${r.text}${r.appliesTo?.channels?.length ? ` {channels: ${r.appliesTo.channels.join(', ')}}` : ''}`)
          .join('\n')}${p.content.notes ? `\nNotes: ${p.content.notes}` : ''}\n</rule_pack>`,
    )
    .join('\n\n');
}

export interface PromptParts {
  agent: AgentDefinition;
  orgInstructions?: string;
  skill?: { name: string; instructions: string; notes?: string; rules?: string; output: string };
  dynamic: Record<string, string | undefined>;
  append?: string;
}

export function buildSystemPrompt(p: PromptParts): SystemBlock[] {
  const blocks: SystemBlock[] = [{ text: `${PLATFORM_PROMPT}\n\n# Agent: ${p.agent.agentType}\n${p.agent.prompt}` }];
  if (p.orgInstructions?.trim()) blocks.push({ text: `# Organisation instructions\n${p.orgInstructions.trim()}` });
  if (p.skill) {
    blocks.push({
      text: [
        `# Skill: ${p.skill.name}`,
        `## Task instructions\n${p.skill.instructions.trim()}`,
        p.skill.notes?.trim() ? `## Team notes\n${p.skill.notes.trim()}` : '',
        p.skill.rules?.trim() ? `## Reference rules (cite rule IDs exactly as written)\n<reference>\n${p.skill.rules}\n</reference>` : '',
        `## Output requirements\n${p.skill.output}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
  }
  blocks[blocks.length - 1].cache = true;
  const dyn = Object.entries(p.dynamic)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  blocks.push({ text: `# Session context\n${dyn}${p.append ? `\n\n${p.append}` : ''}` });
  return blocks;
}

export function renderPrompt(system: SystemBlock[], user: string): PromptRecord {
  const statics = system.slice(0, -1).map((b) => b.text);
  return { system: [...statics, DYNAMIC_BOUNDARY, system[system.length - 1].text].join('\n\n'), user };
}

export function repairMessage(problem: string): string {
  return [
    `Your previous reply could not be accepted: ${problem}`,
    'Return the corrected result as ONE JSON object that validates against the JSON Schema given earlier. Output only the JSON object.',
  ].join('\n');
}
