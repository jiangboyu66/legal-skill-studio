/**
 * Feature flags (cf. Claude Code's `feature('X')` gates). Runtime flags here rather than
 * compile-time, so one build can serve different deployments (e.g. disable OCR on small
 * hosts, or the verifier agent where cost matters). Override with FEATURES="+X,-Y".
 */
export const FEATURE_DEFAULTS = {
  /** Local OCR (tesseract.js) for image materials. */
  OCR: true,
  /** Send images / PDFs to vision-capable models alongside extracted text. */
  VISION: true,
  /** LLM verification agent for legal conclusions (deterministic checks always run). */
  VERIFIER_AGENT: true,
  /** Run independent workflow nodes concurrently. */
  PARALLEL_NODES: true,
  /** Mark static system-prompt layers cacheable (Anthropic prompt caching). */
  PROMPT_CACHE: true,
  /** Let skills call tools (read/search document, look up rules) inside the agent loop. */
  AGENT_TOOLS: true,
  /** Warn when materials contain NRIC/FIN-like identifiers (data minimisation hook). */
  PII_GUARD: true,
} as const;

export type FeatureName = keyof typeof FEATURE_DEFAULTS;
export type FeatureSet = Record<FeatureName, boolean>;

export function resolveFeatures(overrides = ''): FeatureSet {
  const set: FeatureSet = { ...FEATURE_DEFAULTS };
  for (const raw of overrides.split(',').map((s) => s.trim()).filter(Boolean)) {
    const on = !raw.startsWith('-');
    const name = raw.replace(/^[+-]/, '').toUpperCase() as FeatureName;
    if (name in set) set[name] = on;
  }
  return set;
}
