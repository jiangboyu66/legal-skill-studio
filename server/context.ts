import type { AppConfig } from './config';
import type { AgentDefinition } from './core/agents';
import type { EvalService } from './core/evalService';
import type { Governance } from './core/governance';
import type { HookRunner } from './core/hooks';
import type { Runtime } from './core/runtime';
import type { WorkflowEngine } from './core/workflow/engine';
import type { FeatureSet } from './features';
import type { LoadedPlugin } from './plugins/loader';
import type { AuthService } from './services/auth';
import type { DocumentService } from './services/documents';
import type { EventBus } from './services/events';
import type { LLMProvider } from './services/llm';
import type { Db } from './services/storage/db';

/** Everything the HTTP layer needs, assembled once in createApp (dependency injection). */
export interface AppContext {
  cfg: AppConfig;
  features: FeatureSet;
  db: Db;
  provider: LLMProvider;
  hooks: HookRunner;
  events: EventBus;
  docs: DocumentService;
  plugins: LoadedPlugin[];
  agents: AgentDefinition[];
  rt: Runtime;
  engine: WorkflowEngine;
  governance: Governance;
  evals: EvalService;
  auth: AuthService;
}
