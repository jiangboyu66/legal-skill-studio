import Ajv, { type ValidateFunction } from 'ajv';
import type { MaterialDocument, OutputField, Rule } from '../../shared/types';

/** Everything a tool may read during one skill execution (dependency-injected, read-only). */
export interface ToolContext {
  /** input key -> document */
  documents: Record<string, MaterialDocument>;
  /** rule id -> rule (from the rule packs referenced by the skill) */
  rules: Map<string, Rule & { packName: string }>;
  /** text inputs, used when a quote must be checked against non-document input */
  inputs: Record<string, string>;
  outputFields?: OutputField[];
}

export interface ToolOutput {
  /** Text returned to the model as tool_result content. */
  content: string;
  /** One-line summary for the transcript UI. */
  summary: string;
  isError?: boolean;
}

/**
 * A tool = a "manual" (description written for the model) + input schema + implementation
 * (cf. Claude Code's Tool.ts). Tools are registered once and assembled into a per-agent pool.
 */
export interface Tool<I = Record<string, unknown>> {
  name: string;
  /** The tool's manual: what it does, when to use / not use it, and how errors are reported. */
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  category: 'document' | 'knowledge' | 'verification' | 'output';
  call(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

export function validateToolInput(tool: Tool, input: unknown): string[] {
  let fn = validators.get(tool.name);
  if (!fn) {
    fn = ajv.compile(tool.inputSchema);
    validators.set(tool.name, fn);
  }
  return fn(input) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath || '(input)'} ${e.message}`);
}
