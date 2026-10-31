// Shared domain types for API server and React client (v2 architecture).

// ───────────────────────── identity & permissions ─────────────────────────
export type Role = 'admin' | 'builder' | 'reviewer' | 'runner';

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  title?: string;
  disabled?: boolean;
  createdAt: string;
}

export type PermissionEffect = 'allow' | 'ask' | 'deny';

/** Org-level managed policy (mirrors settings.json permissions: allow / ask / deny rule lists). */
export interface OrgPolicy {
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  /** Production runs are blocked unless every referenced rule pack has an approved, unexpired version. */
  requireApprovedRulePacks: boolean;
  /** Four-eyes: the person who submitted a change cannot approve it. */
  requireDistinctApprover: boolean;
  /** Extra organisation instructions appended to every agent's system prompt. */
  customInstructions: string;
}

export interface Org {
  id: string;
  name: string;
  policy: OrgPolicy;
  createdAt: string;
}

export interface Me {
  user: User;
  org: Org;
  /** Effective decision for UI gating, keyed by action. */
  can: Record<string, PermissionEffect>;
  /** Only in the login response: the tab's own session token (sent back as `Authorization: Bearer`). */
  sessionToken?: string;
}

// ───────────────────────── skills ─────────────────────────
export type InputType = 'text' | 'long_text' | 'document';

export interface InputField {
  key: string;
  label: string;
  type: InputType;
  required: boolean;
  description?: string;
  defaultValue?: string;
}

export type OutputFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'string_list' | 'object_list';

export interface OutputField {
  key: string;
  label?: string;
  type: OutputFieldType;
  required: boolean;
  description?: string;
  options?: string[];
  fields?: OutputField[];
}

export interface OutputSpec {
  format: 'markdown' | 'json';
  fields: OutputField[];
}

export interface GroundingCheck {
  id: string;
  label: string;
  path: string;
  /** "input:<key>" or "knowledge" (skill notes + referenced rule packs) */
  source: string;
}

/** Second-line check of legal conclusions for list outputs such as findings. */
export interface VerificationConfig {
  enabled: boolean;
  listPath: string;
  ruleIdField: string;
  quoteField: string;
  conclusionField: string;
  severityField?: string;
  /** Workflow/skill input that carries the channel (used for rule applicability). */
  channelInput?: string;
  /** Run the LLM verifier agent in addition to deterministic checks. */
  useAgent: boolean;
}

export interface TestCase {
  id: string;
  name: string;
  inputs: Record<string, string>;
}

export interface SkillConfig {
  instructions: string;
  /** Free-form notes (team guidance). Authoritative rules live in rule packs. */
  knowledge: string;
  rulePackIds: string[];
  inputs: InputField[];
  output: OutputSpec;
  checks: GroundingCheck[];
  verification?: VerificationConfig;
  /** Tools the agent may call while executing this skill (subset of the registry). */
  tools: string[];
  maxTurns?: number;
  maxTokens?: number;
  testCases: TestCase[];
}

export type LifecycleStatus = 'draft' | 'in_review' | 'published';

export interface VersionInfo {
  version: number;
  approvedBy?: string;
  approvedByName?: string;
  submittedBy?: string;
  approvedAt: string;
  changelog?: string;
}

export interface Skill {
  id: string;
  orgId: string;
  name: string;
  description: string;
  category?: string;
  jurisdiction?: string;
  source: 'user' | `plugin:${string}`;
  status: LifecycleStatus;
  draft: SkillConfig;
  /** Latest published version number, if any. */
  publishedVersion?: number;
  published?: SkillConfig;
  versions: VersionInfo[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────── rule packs ─────────────────────────
export type SourceVerification = 'verbatim' | 'paraphrased' | 'unverified';

export interface Rule {
  id: string;
  title: string;
  text: string;
  severity: 'high' | 'medium' | 'low';
  category?: string;
  source: { title: string; url?: string; excerpt?: string; verification: SourceVerification };
  appliesTo?: { channels?: string[] };
}

export interface RulePackContent {
  rules: Rule[];
  notes?: string;
}

export interface RulePackApproval {
  version: number;
  approvedBy: string;
  approverName: string;
  approverQualification: string;
  attestation: string;
  approvedAt: string;
  reviewDueAt: string;
  comment?: string;
}

export type RulePackStatus = 'draft' | 'in_review' | 'approved' | 'expired';

export interface RulePack {
  id: string;
  orgId: string;
  name: string;
  jurisdiction: string;
  description: string;
  source: 'user' | `plugin:${string}`;
  status: RulePackStatus;
  draft: RulePackContent;
  approvedVersion?: number;
  approved?: RulePackContent;
  approval?: RulePackApproval;
  history: RulePackApproval[];
  updatedAt: string;
  updatedBy: string;
}

// ───────────────────────── workflows ─────────────────────────
export type Mapping =
  | { type: 'workflow_input'; key: string }
  | { type: 'node_output'; nodeId: string; path?: string }
  | { type: 'literal'; value: string }
  | { type: 'coalesce'; options: Mapping[] };

interface NodeBase {
  id: string;
  name: string;
  /** Upstream node ids; the node starts when all of them are finished (succeeded or skipped). */
  needs: string[];
  /** Optional condition, e.g. nodes.check.output.overall_risk == "high" */
  when?: string;
}

export interface SkillNode extends NodeBase {
  type: 'skill';
  skillId: string;
  mappings: Record<string, Mapping>;
}

export interface ApprovalNode extends NodeBase {
  type: 'approval';
  instructions: string;
  /** Results of these nodes are shown to the approver. */
  showNodeIds: string[];
  approverRole: Role;
  onReject: 'stop' | 'continue';
}

export type WorkflowNode = SkillNode | ApprovalNode;

export interface WorkflowDef {
  inputs: InputField[];
  nodes: WorkflowNode[];
  outputNodeId?: string;
  /**
   * Skill versions pinned when this workflow version was approved (skillId → version).
   * Production runs use exactly these versions; publishing a newer skill version does not change
   * an approved workflow until the workflow is re-submitted and approved again.
   */
  pins?: Record<string, number>;
}

export interface Workflow {
  id: string;
  orgId: string;
  name: string;
  description: string;
  source: 'user' | `plugin:${string}`;
  status: LifecycleStatus;
  draft: WorkflowDef;
  publishedVersion?: number;
  published?: WorkflowDef;
  versions: VersionInfo[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
  field?: string;
}

// ───────────────────────── review requests (publish approval) ─────────────────────────
export type ReviewEntity = 'skill' | 'workflow' | 'rulepack';

export interface ReviewRequest {
  id: string;
  orgId: string;
  entityType: ReviewEntity;
  entityId: string;
  entityName: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  submittedBy: string;
  submittedByName: string;
  note?: string;
  decidedBy?: string;
  decidedByName?: string;
  comment?: string;
  /** Content submitted for review (what gets published on approval). */
  snapshot?: unknown;
  createdAt: string;
  decidedAt?: string;
}

// ───────────────────────── documents ─────────────────────────
export type DocumentKind = 'pdf' | 'docx' | 'image' | 'text';

export interface DocumentPage {
  n: number;
  text: string;
  ocrConfidence?: number;
}

export interface MaterialDocument {
  id: string;
  orgId: string;
  filename: string;
  mime: string;
  kind: DocumentKind;
  size: number;
  sha256: string;
  status: 'ready' | 'failed';
  method: 'text-layer' | 'docx' | 'ocr' | 'plain';
  pages: DocumentPage[];
  warnings: string[];
  uploadedBy: string;
  createdAt: string;
}

export type DocumentSummary = Omit<MaterialDocument, 'pages'> & { pageCount: number; chars: number; preview: string; ocrConfidence?: number };

// ───────────────────────── execution ─────────────────────────
export interface AppErrorInfo {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

export interface GroundingItemResult {
  location: string;
  value: string;
  found: boolean;
  match?: 'exact' | 'fuzzy';
  page?: number;
}

export interface GroundingResult {
  checkId: string;
  label: string;
  path: string;
  source: string;
  sourceLabel: string;
  total: number;
  passed: number;
  items: GroundingItemResult[];
  note?: string;
}

export type Verdict = 'supported' | 'partially_supported' | 'unsupported' | 'needs_facts' | 'not_checked';

export interface VerificationItem {
  index: number;
  location: string;
  ruleId: string;
  ruleExists: boolean;
  ruleTitle?: string;
  quoteFound: boolean;
  /** 'fuzzy' = only an approximate (OCR-tolerant) match: the reviewer must compare with the original. */
  quoteMatch?: 'exact' | 'fuzzy';
  page?: number;
  applicability: 'ok' | 'warn' | 'unknown';
  applicabilityNote?: string;
  severity: 'ok' | 'warn' | 'unknown';
  severityNote?: string;
  verdict: Verdict;
  reason?: string;
  missingFacts?: string[];
  /**
   * Priority flag. Every finding needs human review before use; this marks the ones to look at first
   * (failed deterministic check, approximate quote, or the verifier did not fully support it).
   */
  needsHumanReview: boolean;
}

export interface VerificationResult {
  items: VerificationItem[];
  summary: Record<Verdict, number> & { flagged: number };
  agentUsed: boolean;
  note?: string;
}

export interface Validation {
  schemaErrors: string[];
  repaired: boolean;
  grounding: GroundingResult[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Agent transcript entry (QueryEngine messages, simplified for display/audit). */
export type TranscriptEntry =
  | { type: 'assistant_text'; text: string; turn: number }
  | { type: 'tool_call'; turn: number; id: string; name: string; input: unknown }
  | { type: 'tool_result'; turn: number; id: string; name: string; ok: boolean; summary: string }
  | { type: 'permission'; turn: number; tool: string; decision: PermissionEffect; reason?: string }
  | { type: 'hook'; turn: number; hook: string; message: string }
  | { type: 'note'; turn: number; message: string }
  /** The model's reasoning for one turn ("深度思考"), recorded only when the run asked to show it. */
  | { type: 'thinking'; turn: number; text: string; agent?: string };

export interface PromptRecord {
  system: string;
  user: string;
}

/** What the pre/post guards did around one model execution (shown in the UI and kept in the run record). */
export interface SecurityReport {
  /** Identifiers replaced with placeholders before the model call, e.g. "NRIC/FIN ×1，电话号码 ×1". */
  pseudonymized?: string;
  pseudonymizedCount?: number;
  /** Original files (image / PDF) not sent to the model because they contain personal identifiers. */
  visionWithheld?: string[];
  /** Suspected prompt-injection phrases found in the material (analysed as data, not followed). */
  injectionSuspected?: string[];
  /** External images removed from the output. */
  externalImagesRemoved?: number;
  /** Set when the output was withheld because it leaked the system prompt / canary. */
  leakBlocked?: string;
  /** Random boundary tag used to fence untrusted material in this execution. */
  inputTag?: string;
}

export interface Jurisdiction {
  value: string;
  /** true when the user did not choose it (inferred from rule packs / defaults). */
  assumed: boolean;
  source: string;
}

export interface SkillExecution {
  ok: boolean;
  output?: unknown;
  rawOutput?: string;
  validation?: Validation;
  verification?: VerificationResult;
  security?: SecurityReport;
  prompt: PromptRecord;
  transcript: TranscriptEntry[];
  usage?: Usage;
  model?: string;
  turns: number;
  attempts: number;
  latencyMs: number;
  error?: AppErrorInfo;
  /** Set when a tool needs human permission ("ask"); the node waits for approval. */
  permissionRequest?: { tool: string; input: unknown; reason: string };
}

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'rejected' | 'canceled';
export type NodeStatus = 'pending' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'rejected';

export interface ApprovalDecision {
  decision: 'approved' | 'rejected';
  comment?: string;
  byUserId: string;
  byName: string;
  at: string;
}

export interface NodeRun {
  nodeId: string;
  type: 'skill' | 'approval';
  name: string;
  status: NodeStatus;
  skillId?: string;
  skillName?: string;
  skillVersion?: number | 'draft';
  outputFormat?: 'markdown' | 'json';
  outputFields?: OutputField[];
  resolvedInputs?: Record<string, string>;
  prompt?: PromptRecord;
  transcript?: TranscriptEntry[];
  rawOutput?: string;
  output?: unknown;
  validation?: Validation;
  verification?: VerificationResult;
  security?: SecurityReport;
  usage?: Usage;
  model?: string;
  turns?: number;
  attempts?: number;
  skipReason?: string;
  /** Result copied from an earlier run (retry from the failed node). */
  reusedFrom?: string;
  approval?: ApprovalDecision;
  approvalRequest?: { instructions: string; approverRole: Role; tool?: string; reason?: string };
  startedAt?: string;
  finishedAt?: string;
  latencyMs?: number;
  error?: AppErrorInfo;
}

export type FaultType = 'none' | 'auth' | 'rate_limit' | 'timeout' | 'server_error' | 'bad_output' | 'bad_output_once';

export interface FaultInjection {
  type: FaultType;
  nodeId?: string;
}

export interface ProviderInfo {
  name: 'anthropic' | 'openai' | 'deepseek' | 'mock';
  model: string;
  mode: 'real' | 'mock';
  vision: boolean;
  /** The model returns its reasoning (DeepSeek thinking mode, Claude thinking; simulated in mock mode). */
  thinking?: boolean;
}

export interface RulePackSnapshot {
  id: string;
  name: string;
  version: number | 'draft';
  status: RulePackStatus;
  approval?: RulePackApproval;
}

export interface RunWarning {
  code: string;
  message: string;
}

export interface Run {
  id: string;
  orgId: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number | 'draft';
  mode: 'production' | 'test';
  status: RunStatus;
  startedBy: string;
  startedByName: string;
  inputs: Record<string, string>;
  /** inputKey -> document id (document inputs) */
  documents: Record<string, string>;
  provider: ProviderInfo;
  faultInjection?: FaultInjection;
  definition: WorkflowDef;
  /** Snapshot of every skill configuration used (published version or draft), so runs are reproducible and resumable. */
  skills: Record<string, { name: string; version: number | 'draft'; config: SkillConfig }>;
  rulePacks: RulePackSnapshot[];
  rulePackContents: Record<string, RulePackContent>;
  nodes: Record<string, NodeRun>;
  order: string[];
  finalOutput?: unknown;
  finalFormat?: 'markdown' | 'json';
  /** Node whose output is the final result. */
  finalNodeId?: string;
  /** Applicable law for this run — explicit input, or an assumption shown on every result. */
  jurisdiction?: Jurisdiction;
  reviews: Record<string, ReviewMark>;
  /** Issues the reviewer found that the AI missed (feedback for evaluation / optimisation). */
  missed?: MissedFinding[];
  warnings: RunWarning[];
  grantedTools: string[];
  usage: Usage;
  error?: AppErrorInfo;
  /** Re-run of an earlier run with the current configuration (all nodes). */
  rerunOf?: string;
  /** Retry of a failed run with the same versions; successful nodes were reused. */
  retryOf?: string;
  /** Activity log ("运行过程"): printed live while the run executes and kept for replay. */
  log?: RunLogEntry[];
  options?: RunOptions;
  /** Set when someone stopped the run by hand. */
  canceled?: { byUserId: string; byName: string; at: string };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type RunLogKind = 'run' | 'node' | 'model' | 'thinking' | 'tool' | 'result' | 'approval' | 'note' | 'error';

/** Per-run display options chosen when the run is started. */
export interface RunOptions {
  /** "深度思考": record and show the model's reasoning (only for roles that may see run internals). */
  showThinking?: boolean;
}

/** One line of a run's activity log. `status` records the node / run state after the event (drives replay). */
export interface RunLogEntry {
  seq: number;
  at: string;
  kind: RunLogKind;
  nodeId?: string;
  status?: NodeStatus | RunStatus;
  text: string;
  detail?: string;
  /** Rebuilt from a run recorded before activity logs existed; times are estimated. */
  approx?: boolean;
}

/** accepted = finding is right; edited = right but corrected by the reviewer; rejected = wrong. */
export type ReviewDecision = 'accepted' | 'edited' | 'rejected';

export interface ReviewMark {
  decision: ReviewDecision;
  note?: string;
  /** Corrected field values (decision = edited). */
  edits?: Record<string, string>;
  by: string;
  byName: string;
  at: string;
}

export interface MissedFinding {
  id: string;
  nodeId: string;
  ruleId: string;
  quote: string;
  issue: string;
  by: string;
  byName: string;
  at: string;
}

/** Reviewer feedback for one run or aggregated over runs: H = A / (A + Jr + 2M) (edits count as accepted). */
export interface FeedbackStats {
  accepted: number;
  edited: number;
  rejected: number;
  missed: number;
  pending: number;
  h?: number;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  mode: Run['mode'];
  status: RunStatus;
  provider: ProviderInfo;
  startedByName: string;
  createdAt: string;
  finishedAt?: string;
  nodeCount: number;
  failedNode?: string;
  waitingNode?: string;
  errorCode?: string;
  costUsd?: number;
}

/** Server-sent events on /api/runs/:id/events (the "bridge" protocol between UI and engine). */
export type RunEvent =
  | { type: 'run_status'; runId: string; status: RunStatus }
  | { type: 'node_status'; runId: string; nodeId: string; status: NodeStatus }
  | { type: 'transcript'; runId: string; nodeId: string; entry: TranscriptEntry }
  | { type: 'approval_requested'; runId: string; nodeId: string }
  | { type: 'approval_decided'; runId: string; nodeId: string; decision: 'approved' | 'rejected' }
  | { type: 'log'; runId: string; entry: RunLogEntry }
  /** Live reasoning text while a model call streams (not stored; the full text is stored as a transcript entry). */
  | { type: 'thinking_delta'; runId: string; nodeId: string; key: string; text: string; agent?: string };

export interface AuditEvent {
  id: string;
  orgId: string;
  userId?: string;
  userName?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  detail?: unknown;
  at: string;
}

export interface SampleMaterial {
  id: string;
  title: string;
  description: string;
  inputs: Record<string, string>;
  /** Bundled file (PDF / Word / image) to upload as the material instead of text. */
  file?: string;
}

// ───────────────────────── conversations (chat home) ─────────────────────────
export interface ChatAttachment {
  documentId: string;
  filename: string;
  kind?: MaterialDocument['kind'];
  pageCount?: number;
}

/** run = review new material with a workflow; ask = follow-up question about a run's results. */
export type ChatMode = 'run' | 'ask';

export type ConversationMessage =
  | { id: string; role: 'user'; at: string; mode: ChatMode; text: string; attachments?: ChatAttachment[]; workflowId?: string; workflowName?: string; runId?: string }
  | { id: string; role: 'assistant'; at: string; kind: 'run'; runId: string; workflowId: string; workflowName: string }
  | { id: string; role: 'assistant'; at: string; kind: 'answer'; text: string; runId: string; provider: ProviderInfo; usage?: Usage; security?: SecurityReport; latencyMs?: number; thinking?: string }
  | { id: string; role: 'assistant'; at: string; kind: 'error'; text: string; code?: string; hint?: string; runId?: string };

export interface Conversation {
  id: string;
  orgId: string;
  /** Conversations are private to the user who created them. */
  userId: string;
  title: string;
  /** Workflow used for the last "run" message (default for the next one). */
  workflowId?: string;
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastText?: string;
  runIds: string[];
}

export interface ChatSendResult {
  conversation: Conversation;
  run?: Run;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  builtIn: boolean;
  contributes: { skills: string[]; rulePacks: string[]; workflows: string[]; agents: string[]; hooks: string[] };
}

export interface ToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
}

export interface AgentInfo {
  agentType: string;
  description: string;
  tools: string[];
  source: 'built-in' | `plugin:${string}`;
}

export interface Meta {
  provider: ProviderInfo;
  hasRealKey: boolean;
  appVersion: string;
  features: Record<string, boolean>;
  demoAccounts: boolean;
}

// ───────────────────────── evaluation & optimisation ─────────────────────────
export interface EvalExpected {
  id: string;
  description: string;
  /** Acceptable rule IDs (a finding citing any of them can match). */
  rules: string[];
  /** Verbatim fragments of the material; the finding's quote must contain one of them (case-insensitive). */
  anchors: string[];
}

export interface EvalMustNotFlag {
  /** A finding citing one of these rules (and, if given, quoting the anchor) is a known false positive. */
  rules?: string[];
  anchor?: string;
  reason: string;
}

export interface EvalCase {
  id: string;
  split: 'train' | 'holdout';
  title: string;
  tags: string[];
  /** Skill inputs by key (e.g. material, channel). */
  inputs: Record<string, string>;
  expected: EvalExpected[];
  mustNotFlag: EvalMustNotFlag[];
  notes?: string;
}

export interface EvalSetInfo {
  id: string;
  name: string;
  description: string;
  labelledBy: string;
  target: { listPath: string; ruleIdField: string; quoteField: string };
  counts: { train: number; holdout: number; expected: number };
}

export interface EvalCaseResult {
  caseId: string;
  title: string;
  split: 'train' | 'holdout';
  tags: string[];
  ok: boolean;
  error?: AppErrorInfo;
  findings: number;
  expected: number;
  matched: string[];
  missed: { id: string; description: string; rules: string[] }[];
  falsePositives: { index: number; ruleId: string; quote: string; reason: string }[];
  mustNotFlagHits: { index: number; ruleId: string; reason: string }[];
  quotesVerified: number;
  unknownRules: number;
  usage?: Usage;
  latencyMs: number;
}

export interface EvalMetrics {
  cases: number;
  errors: number;
  expected: number;
  matchedExpected: number;
  findings: number;
  correctFindings: number;
  recall?: number;
  precision?: number;
  f2?: number;
  /** Share of findings whose quote is found verbatim (or OCR-approximately) in the material. */
  quoteRate?: number;
  unknownRuleRate?: number;
  mustNotFlag: number;
  costUsd?: number;
  tokens: number;
  avgLatencyMs: number;
  /** Computable part of the guide's R(v): 0.5·F2 + 0.15·Q (+0.25·H when feedback exists). */
  score?: number;
}

export interface EvalRun {
  id: string;
  orgId: string;
  skillId: string;
  skillName: string;
  evalSetId: string;
  version: number | 'draft' | 'candidate';
  configHash: string;
  split: 'train' | 'holdout' | 'all';
  status: 'running' | 'succeeded' | 'failed';
  provider: ProviderInfo;
  rulePacks: RulePackSnapshot[];
  startedBy: string;
  startedByName: string;
  createdAt: string;
  finishedAt?: string;
  progress: { done: number; total: number };
  cases: EvalCaseResult[];
  metrics: { all?: EvalMetrics; train?: EvalMetrics; holdout?: EvalMetrics };
  /** Reviewer feedback on production/test runs of this skill version (published versions only). */
  feedback?: FeedbackStats;
  optimizationId?: string;
  warnings: RunWarning[];
  error?: AppErrorInfo;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface OptimizationRun {
  id: string;
  orgId: string;
  skillId: string;
  skillName: string;
  status: 'running' | 'succeeded' | 'failed';
  provider: ProviderInfo;
  baseline: { evalId: string; configHash: string; instructions: string };
  /** Evidence given to the optimiser — training-split failures and reviewer feedback only (never holdout). */
  evidence: { missed: number; falsePositives: number; mustNotFlag: number; feedback: number };
  candidate?: { instructions: string; rationale: string; changes: string[] };
  candidateEvalId?: string;
  gate?: { passed: boolean; checks: GateCheck[] };
  adopted?: { by: string; byName: string; at: string };
  startedBy: string;
  startedByName: string;
  createdAt: string;
  finishedAt?: string;
  usage?: Usage;
  error?: AppErrorInfo;
}

export interface HealthInfo {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSec: number;
  provider: { name: string; mode: 'real' | 'mock'; model: string; configured: boolean };
  encryptionAtRest: boolean;
  retentionDays: number;
  checks: { name: string; ok: boolean; message: string }[];
}

// ───────────────────────── API views ─────────────────────────
export interface PendingReviewRef {
  id: string;
  submittedByName: string;
  createdAt: string;
  note?: string;
}

export interface EntityViewMeta {
  /** Draft differs from the published / approved version. */
  dirty: boolean;
  pendingReview?: PendingReviewRef;
}

export type SkillView = Skill & EntityViewMeta & { usedBy: { id: string; name: string }[] };
export interface PinInfo {
  skillId: string;
  skillName: string;
  /** Version pinned in the published workflow (undefined for workflows published before pinning existed). */
  pinned?: number;
  /** Latest published version of the skill. */
  latest?: number;
}

export type WorkflowView = Workflow & EntityViewMeta & { issues: ValidationIssue[]; pinInfo: PinInfo[] };

export interface RulePackStats {
  total: number;
  verbatim: number;
  paraphrased: number;
  unverified: number;
}
export type RulePackView = RulePack & EntityViewMeta & { usedBy: { id: string; name: string }[]; stats: RulePackStats };

export type ReviewRequestView = Omit<ReviewRequest, 'snapshot'> & { canDecide: boolean; canWithdraw: boolean; blockedReason?: string };

export interface NodeApprovalItem {
  runId: string;
  workflowName: string;
  mode: Run['mode'];
  nodeId: string;
  nodeName: string;
  approverRole: Role;
  tool?: string;
  reason?: string;
  startedByName: string;
  requestedAt?: string;
  canDecide: boolean;
  blockedReason?: string;
}

export interface ReviewInbox {
  requests: ReviewRequestView[];
  nodeApprovals: NodeApprovalItem[];
}

export interface ReviewDetail {
  request: ReviewRequestView & { snapshot?: unknown };
  entity: { id: string; name: string; description: string; source: string };
  /** Currently published / approved content, for comparison. */
  current?: unknown;
  currentVersion?: number;
  stats?: RulePackStats;
  /** Skill reviews: latest evaluation of the submitted configuration and of the published version. */
  evals?: { submitted?: EvalRun; published?: EvalRun };
}

export interface SkillEvalsView {
  set?: EvalSetInfo;
  /** Why the skill cannot be evaluated (no matching eval set). */
  notApplicable?: string;
  draftHash: string;
  runs: EvalRun[];
  optimizations: OptimizationRun[];
}

export interface SkillTestResult {
  execution: SkillExecution;
  warnings: RunWarning[];
  rulePacks: RulePackSnapshot[];
  provider: ProviderInfo;
}

export interface PlatformInfo {
  /** Baseline allow rules per role (the org policy adjusts them). */
  roles: Record<Role, string[]>;
  plugins: PluginInfo[];
  tools: ToolInfo[];
  agents: AgentInfo[];
  hooks: { name: string; event: string; description: string }[];
  features: Record<string, boolean>;
}

export interface DemoAccounts {
  /** Test accounts, one per role, each with its own password (shown only while unchanged). */
  accounts: { email: string; name: string; role: Role; title?: string; password?: string; passwordChanged?: boolean }[];
}
