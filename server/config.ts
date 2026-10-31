import 'dotenv/config';
import path from 'node:path';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

export interface AppConfig {
  port: number;
  dataDir: string;
  provider: 'auto' | 'anthropic' | 'openai' | 'deepseek' | 'mock';
  anthropic: { apiKey: string; model: string; baseUrl: string; version: string; effort: string };
  openai: { apiKey: string; model: string; baseUrl: string; jsonMode: boolean; maxTokens: number; tools: boolean; vision: boolean };
  /** DeepSeek (OpenAI-compatible API). Thinking mode is the API default; reasoning_content is replayed in tool loops. */
  deepseek: { apiKey: string; model: string; baseUrl: string; thinking: 'enabled' | 'disabled'; reasoningEffort: string; maxTokens: number; tools: boolean; vision: boolean };
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  maxTurns: number;
  mockLatencyMs: number;
  retryBaseMs: number;
  workflowConcurrency: number;
  sessionTtlHours: number;
  /** USD per million tokens; 0 = unknown (cost is then not estimated). */
  priceInputPerMTok: number;
  priceOutputPerMTok: number;
  /** Price of cached input tokens; 0 = 10 % of the input price. */
  priceCacheReadPerMTok: number;
  budgetUsdPerRun: number;
  demoAccounts: boolean;
  /** Raw feature overrides from env: FEATURES=+OCR,-VISION */
  featureOverrides: string;
  ocrLangs: string;
  /** 32-byte key (base64 / hex) for encrypting materials, runs and evaluations at rest; empty = off. */
  dataEncryptionKey: string;
  /** Delete finished runs, evaluations and unreferenced documents older than N days; 0 = keep. */
  retentionDays: number;
}

/** Reads configuration from environment variables. Secrets are never logged or sent to the client. */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const provider = str('LLM_PROVIDER', 'auto').toLowerCase() as AppConfig['provider'];
  const thinking = str('DEEPSEEK_THINKING', 'enabled').toLowerCase();
  const cfg: AppConfig = {
    port: num('PORT', 8787),
    dataDir: path.resolve(str('DATA_DIR', './data')),
    provider: ['auto', 'anthropic', 'openai', 'deepseek', 'mock'].includes(provider) ? provider : 'auto',
    anthropic: {
      apiKey: str('ANTHROPIC_API_KEY'),
      model: str('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
      baseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, ''),
      version: str('ANTHROPIC_VERSION', '2023-06-01'),
      effort: str('ANTHROPIC_EFFORT'),
    },
    openai: {
      apiKey: str('OPENAI_API_KEY'),
      model: str('OPENAI_MODEL', 'gpt-5-mini'),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
      jsonMode: bool('OPENAI_JSON_MODE', false),
      maxTokens: num('OPENAI_MAX_TOKENS', 0),
      tools: bool('OPENAI_TOOLS', true),
      vision: bool('OPENAI_VISION', false),
    },
    deepseek: {
      apiKey: str('DEEPSEEK_API_KEY'),
      model: str('DEEPSEEK_MODEL', 'deepseek-flash'),
      baseUrl: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
      thinking: thinking === 'disabled' || thinking === 'false' || thinking === 'off' ? 'disabled' : 'enabled',
      reasoningEffort: str('DEEPSEEK_REASONING_EFFORT', 'high').toLowerCase(),
      maxTokens: num('DEEPSEEK_MAX_TOKENS', 32_768),
      tools: bool('DEEPSEEK_TOOLS', true),
      vision: bool('DEEPSEEK_VISION', true),
    },
    timeoutMs: num('LLM_TIMEOUT_MS', 120_000),
    maxRetries: num('LLM_MAX_RETRIES', 2),
    maxTokens: num('LLM_MAX_TOKENS', 16_000),
    maxTurns: num('AGENT_MAX_TURNS', 8),
    mockLatencyMs: num('MOCK_LATENCY_MS', 500),
    retryBaseMs: num('LLM_RETRY_BASE_MS', 1_000),
    workflowConcurrency: Math.max(1, num('WORKFLOW_CONCURRENCY', 4)),
    sessionTtlHours: num('SESSION_TTL_HOURS', 12),
    priceInputPerMTok: num('MODEL_PRICE_INPUT_PER_MTOK', 0),
    priceOutputPerMTok: num('MODEL_PRICE_OUTPUT_PER_MTOK', 0),
    priceCacheReadPerMTok: num('MODEL_PRICE_CACHE_READ_PER_MTOK', 0),
    budgetUsdPerRun: num('RUN_BUDGET_USD', 0),
    demoAccounts: bool('DEMO_ACCOUNTS', true),
    featureOverrides: str('FEATURES'),
    ocrLangs: str('OCR_LANGS', 'eng'),
    dataEncryptionKey: str('DATA_ENCRYPTION_KEY'),
    retentionDays: Math.max(0, num('RETENTION_DAYS', 0)),
  };
  return { ...cfg, ...overrides };
}
