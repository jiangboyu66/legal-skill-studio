import type { MaterialDocument, Usage, User } from '../../shared/types';
import type { AppConfig } from '../config';
import type { FeatureSet } from '../features';
import type { LLMProvider } from '../services/llm';
import type { EventBus } from '../services/events';
import type { Db } from '../services/storage/db';
import type { AgentDefinition } from './agents';
import type { HookRunner } from './hooks';

/**
 * Dependency-injection container passed to the engine (cf. QueryEngineConfig / ToolUseContext):
 * services are injected as values and functions so every part can be tested with fakes.
 */
export interface Runtime {
  cfg: AppConfig;
  features: FeatureSet;
  provider: LLMProvider;
  hooks: HookRunner;
  db: Db;
  events: EventBus;
  agents: AgentDefinition[];
  priceFn: (u: Usage) => number | undefined;
  readFile: (doc: MaterialDocument) => Buffer | undefined;
  audit: (orgId: string, user: Pick<User, 'id' | 'name'> | undefined, action: string, entityType?: string, entityId?: string, detail?: unknown) => void;
}
