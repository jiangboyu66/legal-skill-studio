import type { InputField, OutputField, ProviderInfo, Usage } from '../../../shared/types';

/** Provider-neutral content blocks (modelled on the Messages API). */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'document'; mediaType: 'application/pdf'; dataBase64: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: Block[];
  /** Provider-native assistant content (e.g. thinking blocks) replayed verbatim on the next turn. */
  raw?: unknown;
}

/** System prompt layer; `cache` marks the end of a static prefix that may be prompt-cached. */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Extra context only the mock provider uses to simulate an agent. */
export interface MockHints {
  skillName: string;
  agentType: string;
  format: 'markdown' | 'json';
  fields: OutputField[];
  inputDefs: InputField[];
  inputs: Record<string, string>;
  knowledge: string;
}

export interface CompletionRequest {
  system: SystemBlock[];
  messages: ChatMessage[];
  tools?: ToolSchema[];
  maxTokens: number;
  wantJson?: boolean;
  hints?: MockHints;
}

export interface CompletionResult {
  /** text and tool_use blocks only */
  content: Block[];
  raw?: unknown;
  model: string;
  usage?: Usage;
  /** 'end' | 'tool_use' | 'max_tokens' | 'refusal' | provider-specific */
  stopReason: string;
}

export interface ProviderCapabilities {
  tools: boolean;
  vision: boolean;
  pdf: boolean;
  promptCache: boolean;
}

export interface LLMProvider {
  info: ProviderInfo;
  capabilities: ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export const textOf = (blocks: Block[]) =>
  blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
