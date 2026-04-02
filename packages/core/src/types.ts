export type TaskType = "SIMPLE" | "COMPLEX" | "CODING";
export type TaskIntent = "qa" | "office_discussion" | "doc" | "ppt" | "image" | "video" | "coding";
export type TaskBudget = "low" | "standard" | "high";
export type ArtifactType = "none" | "doc" | "ppt" | "image" | "video";
export type TaskQualityLevel = "fast" | "standard" | "high" | "strict";
export type TaskRiskLevel = "low" | "medium" | "high" | "critical";
export type TaskComplexity = "easy" | "medium" | "hard";
export type MemoryLayer = "working" | "episodic" | "long_term";
export type ModelPresetName = "standard" | "pro" | "expert" | "deep";
export type ReasoningIntensity = "low" | "medium" | "high" | "very_high";
export type CostLevel = "low" | "medium" | "high" | "premium";
export type ContextWindowSize = "small" | "medium" | "high" | "very_high";
export type ApprovalPolicyMode = "auto" | "manual" | "observe";
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "resolved" | "expired";
export type ApprovalRequestKind = "cli_authorization" | "human_review" | "desktop_control" | "filesystem_write" | "model_upgrade";

export type ProviderTier = "cheap" | "mid" | "strong" | "free";

export type TaskTier = "T0" | "T1" | "T2" | "T3";
export type ProviderCapability =
  | "cheap_chat"
  | "office_draft"
  | "office_review"
  | "office_arbiter"
  | "coding_draft"
  | "coding_review"
  | "coding_arbiter"
  | "doc_draft"
  | "doc_review"
  | "image_draft"
  | "image_review"
  | "ppt_draft"
  | "ppt_review"
  | "video_draft"
  | "video_review";

export type AgentRole =
  | "crown_orchestrator"
  | "zhongshu_drafter"
  | "hanlin_reviewer"
  | "menxia_auditor"
  | "zhongshu_arbiter"
  | "shangshu_executor"
  | "junji_implementer"
  | "sitian_monitor";

export type AuditTrigger =
  | "prompt_required"
  | "quality_gate"
  | "complexity_threshold"
  | "risk_threshold"
  | "artifact_guardrail";

export type AuditDecision = "pass" | "revise_required" | "reject";

export type TaskStatus =
  | "queued"
  | "classifying"
  | "routing"
  | "skill_planning"
  | "drafting"
  | "reviewing"
  | "audit_pending"
  | "audit_revising"
  | "arbitrating"
  | "handoff_to_codex"
  | "implementing"
  | "testing"
  | "monitoring"
  | "completed"
  | "failed"
  | "needs_browser_launch"
  | "provider_session_lost"
  | "needs_manual_login"
  | "needs_human_intervention";

export type StepStatus = "started" | "completed" | "failed";

export type ProviderStateStatus =
  | "available"
  | "disabled"
  | "degraded"
  | "unhealthy"
  | "needs_browser_launch"
  | "provider_session_lost"
  | "needs_manual_login";

export interface TaskSubmission {
  input: string;
  requestedType?: TaskType;
  requestedIntent?: TaskIntent;
  budget?: TaskBudget;
  artifactType?: ArtifactType;
  qualityLevel?: TaskQualityLevel;
  riskLevel?: TaskRiskLevel;
  complexity?: TaskComplexity;
  requiresAudit?: boolean;
  requestedSkills?: string[];
  presetHints?: {
    preferredReasoning?: ModelPresetName;
    maxLatencyMs?: number;
    costSensitivity?: "low" | "medium" | "high";
  };
  executionPolicy?: {
    allowPresetUpgrade?: boolean;
    allowPresetDowngrade?: boolean;
    allowProviderFallback?: boolean;
    forceProvider?: string;
    forcePreset?: ModelPresetName;
    discussionMode?: "default" | "all_advanced";
  };
  source?: string;
  sourceMeta?: Record<string, unknown>;
}

export interface TaskStepRecord {
  id: string;
  taskId: string;
  phase: TaskStatus;
  provider?: string | null;
  status: StepStatus;
  inputSummary?: string | null;
  outputSummary?: string | null;
  meta?: Record<string, unknown> | null;
  startedAt: Date;
  endedAt?: Date | null;
}

export interface TaskRecord {
  id: string;
  type: TaskType;
  status: TaskStatus;
  source: string;
  sourceMeta?: Record<string, unknown> | null;
  userInput: string;
  normalizedInput: string;
  summary?: string | null;
  outputSummary?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  cacheKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | null;
  steps?: TaskStepRecord[];
}

export interface TaskListItem {
  id: string;
  type: TaskType;
  status: TaskStatus;
  source: string;
  summary?: string | null;
  outputSummary?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeEntryRecord {
  id: string;
  key: string;
  scope: string;
  kind: "task_history" | "preference" | "project_context" | "fact" | "manual_note";
  layer: MemoryLayer;
  title: string;
  content: string;
  summary?: string | null;
  tags: string[];
  importance: number;
  source?: string | null;
  sourceTaskId?: string | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date | null;
}

export interface LayeredContext {
  rawInput: string;
  normalizedTaskBrief: string;
  providerPrompt: string;
  finalSummary?: string;
}

export interface ProviderRuntimeConfig {
  name: string;
  enabled: boolean;
  tier?: ProviderTier;
  capabilities?: ProviderCapability[];
  mode: "persistent" | "cdp" | "api";
  browser?: "chromium" | "firefox";
  baseUrl?: string;
  profileDir?: string;
  selectorProfile?: string;
  allowedDomains: string[];
  headless: boolean;
  timeoutMs: number;
  maxConcurrency: number;
  rateLimitPerMinute: number;
  cdpEndpoint?: string;
  launchOptions?: Record<string, unknown>;
  browserChannel?: string;
  metadata?: Record<string, unknown>;
  defaultPreset?: ModelPresetName;
  presets?: Record<string, ProviderPresetConfig>;
}

export interface ProviderPresetUiMode {
  modelSlug?: string;
  reasoningMode?: string;
  openMenuSelectors?: string[];
  optionSelectors?: string[];
  optionText?: string;
  directSelectors?: string[];
  verifySelectors?: string[];
  waitAfterMs?: number;
  steps?: ProviderPresetUiAction[];
}

export interface ProviderPresetUiAction {
  openMenuSelectors?: string[];
  optionSelectors?: string[];
  optionText?: string;
  directSelectors?: string[];
  verifySelectors?: string[];
  waitAfterMs?: number;
}

export interface ProviderPresetConfig {
  label?: string;
  reasoningIntensity: ReasoningIntensity;
  costLevel: CostLevel;
  contextWindow: ContextWindowSize;
  estimatedLatencyMs?: number;
  timeoutMs?: number;
  fallbackPriority?: number;
  recommendedFor?: {
    riskLevels?: TaskRiskLevel[];
    qualityLevels?: TaskQualityLevel[];
    budgets?: TaskBudget[];
    intents?: TaskIntent[];
    artifactTypes?: ArtifactType[];
    complexities?: TaskComplexity[];
    roles?: AgentRole[];
  };
  uiMode?: ProviderPresetUiMode;
}

export interface ProviderHealth {
  provider: string;
  status: ProviderStateStatus;
  detail: string;
  checkedAt: Date;
  recoveryHint?: string;
  meta?: Record<string, unknown>;
}

export interface SessionState {
  ok: boolean;
  requiresManualLogin?: boolean;
  failureKind?: Extract<ProviderStateStatus, "needs_manual_login" | "needs_browser_launch" | "provider_session_lost">;
  detail: string;
  meta?: Record<string, unknown>;
}

export interface ProviderPromptRequest {
  taskId: string;
  taskType: TaskType;
  prompt: string;
  inputSummary: string;
  context?: Record<string, unknown>;
  execution?: {
    role?: AgentRole;
    preset?: ModelPresetName;
    timeoutMs?: number;
  };
}

export interface ProviderRunHandle {
  provider: string;
  startedAt: Date;
  meta?: Record<string, unknown>;
}

export interface ProviderCompletion {
  provider: string;
  completedAt: Date;
  meta?: Record<string, unknown>;
}

export interface ProviderRunResult {
  provider: string;
  outputText: string;
  summary: string;
  rawOutput?: string;
  screenshotPath?: string;
  requiresManualLogin?: boolean;
  meta?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly kind: "mock" | "web" | "scaffold" | "api" | "copilot";
  getConfig(): ProviderRuntimeConfig;
  healthCheck(): Promise<ProviderHealth>;
  ensureSession(): Promise<SessionState>;
  applyPreset?(request: ProviderPromptRequest): Promise<void>;
  sendPrompt(request: ProviderPromptRequest): Promise<ProviderRunHandle>;
  waitForCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion>;
  extractAnswer(completion: ProviderCompletion): Promise<ProviderRunResult>;
  screenshotOnFailure(taskId: string, error: Error): Promise<string | undefined>;
  manualRecoveryHint(): string;
  close?(): Promise<void>;
}

export interface ProviderConfigFile {
  providers: ProviderRuntimeConfig[];
}

export interface RoleConfigFile {
  roles: RoleDefinition[];
}

export interface SkillConfigFile {
  skills: SkillDefinition[];
}

export interface RoutingPolicy {
  defaults: {
    budget: {
      default: TaskBudget;
      multiReviewerMinBudget: TaskBudget;
    };
    review: {
      defaultCount: number;
      upgradedCount: number;
    };
    presets: {
      simple: ModelPresetName;
      office: ModelPresetName;
      artifact: ModelPresetName;
      review: ModelPresetName;
      arbiter: ModelPresetName;
      audit: ModelPresetName;
      highRisk: ModelPresetName;
      strictQuality: ModelPresetName;
    };
    audit: {
      maxAttempts: number;
      lowRiskProviders: string[];
      mediumRiskProviders: string[];
      highRiskProviders: string[];
      criticalRiskProviders: string[];
    };
  };
  simple: {
    cheapProviders: string[];
    fallbackProviders: string[];
  };
  office: {
    draftProvider: string;
    fallbackProviders?: string[];
    reviewer: string;
    extraReviewers: string[];
    finalArbiter: string;
  };
  doc: {
    draftProvider: string;
    fallbackProviders?: string[];
    reviewer: string;
    extraReviewers: string[];
    finalArbiter: string;
    executor: "doc_markdown";
  };
  image: {
    draftProvider: string;
    reviewer: string;
    extraReviewers: string[];
    finalArbiter: string;
    executor: "image_prompt";
  };
  ppt: {
    draftProvider: string;
    reviewer: string;
    extraReviewers: string[];
    finalArbiter: string;
    executor: "ppt_markdown";
  };
  video: {
    draftProvider: string;
    reviewer: string;
    extraReviewers: string[];
    finalArbiter: string;
    executor: "video_plan";
  };
  coding: {
    draftProvider: string;
    reviewer: string;
    extraReviewers: string[];
    finalArbiter: string;
    codex: {
      autoRun: boolean;
    };
  };
}

export interface PromptCatalog {
  classification: string;
  drafting: string;
  review: string;
  arbitration: string;
  codexHandoff: string;
}

export interface CodingArtifacts {
  taskDir: string;
  codexTaskPath: string;
  implementationBriefPath: string;
  implementationPlanPath: string;
  acceptanceChecklistPath: string;
  contextSummaryPath: string;
  executionLogPath?: string;
}

export interface CodingHandoffBundle {
  taskId: string;
  originalRequest: string;
  explicitRunner?: "codex" | "gemini";
  candidatePlans: Array<{
    provider: string;
    plan: string;
  }>;
  finalPlan: string;
  risks: string[];
  impactedFiles: string[];
  testingSuggestions: string[];
  unresolvedQuestions: string[];
}

export interface WorkflowAuditPolicy {
  requested: boolean;
  required: boolean;
  triggers: AuditTrigger[];
  strategy: "structured_gate";
  maxRevisionRounds: number;
  maxAttempts?: number;
  provider?: string;
}

export interface TaskRoleAssignment {
  role: AgentRole;
  title: string;
  provider?: string;
  preset?: ModelPresetName;
  timeoutMs?: number;
  mode: "required" | "optional";
  capabilityHints?: ProviderCapability[];
}

export interface WorkflowRolePlan {
  chain: TaskRoleAssignment[];
}

export interface TaskSkillSelection {
  id: string;
  weight: number;
  reason: string;
  required: boolean;
  packId?: string;
  packName?: string;
}

export interface WorkflowMeta {
  tier: TaskTier;
  intent: TaskIntent;
  budget: TaskBudget;
  artifactType: ArtifactType;
  qualityLevel: TaskQualityLevel;
  riskLevel: TaskRiskLevel;
  complexity: TaskComplexity;
  complexityScore: number;
  audit: WorkflowAuditPolicy;
  selectedSkills: TaskSkillSelection[];
  selectedSkillPacks?: SkillPackRecord[];
  approvalPlan?: TaskApprovalPlan;
  rolePlan?: WorkflowRolePlan;
  modelPlan?: WorkflowModelPlan;
  presetHints?: TaskSubmission["presetHints"];
  executionPolicy?: TaskSubmission["executionPolicy"];
}

export interface ProviderExecutionTarget {
  role: AgentRole;
  provider: string;
  preset: ModelPresetName;
  timeoutMs: number;
  fallbackPriority?: number;
}

export interface WorkflowModelPlan {
  drafter?: ProviderExecutionTarget;
  draftFallbacks?: ProviderExecutionTarget[];
  reviewers?: ProviderExecutionTarget[];
  auditor?: ProviderExecutionTarget;
  auditFallbacks?: ProviderExecutionTarget[];
  arbiter?: ProviderExecutionTarget;
}

export interface WorkflowRoutePlan {
  kind: "simple" | "office" | "doc" | "ppt" | "image" | "video" | "coding";
  draftProvider: string;
  fallbackProviders: string[];
  reviewers: string[];
  finalArbiter?: string;
  executor?: "doc_markdown" | "ppt_markdown" | "image_prompt" | "video_plan";
  useLocalAccess: boolean;
  autoRunCodex: boolean;
  draftTarget?: ProviderExecutionTarget;
  fallbackTargets?: ProviderExecutionTarget[];
  reviewerTargets?: ProviderExecutionTarget[];
  finalArbiterTarget?: ProviderExecutionTarget;
  auditTarget?: ProviderExecutionTarget;
  auditFallbackTargets?: ProviderExecutionTarget[];
}

export interface LocalAccessRequest {
  taskId: string;
  input: string;
  taskType: TaskType;
  intent: TaskIntent;
  workspaceRoot: string;
  maxEntries?: number;
}

export interface LocalAccessResult {
  backend: "codex_cli" | "gemini_cli" | "native_reader";
  summary: string;
  referencedPaths: string[];
  notes?: string[];
}

export interface ExecutorArtifact {
  label: string;
  path: string;
  mimeType?: string;
  sourceUrl?: string;
  imageKey?: string;
}

export interface ArtifactExecutionInput {
  taskId: string;
  intent: Extract<TaskIntent, "doc" | "ppt" | "image" | "video">;
  userInput: string;
  finalOutput: string;
  draftOutput: string;
  reviewOutput?: string;
  localContextSummary?: string;
  providerName?: string;
  providerMeta?: Record<string, unknown>;
}

export interface ArtifactExecutionResult {
  executor: "doc_markdown" | "ppt_markdown" | "image_prompt" | "video_plan";
  artifacts: ExecutorArtifact[];
  summary: string;
}

export interface RoleDefinition {
  id: AgentRole;
  title: string;
  responsibility: string;
  preferredCapabilities: ProviderCapability[];
  preferredTiers: ProviderTier[];
  supportsHotSwap: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  weight: number;
  packId?: string;
  packName?: string;
  packDescription?: string;
  intents?: TaskIntent[];
  taskTypes?: TaskType[];
  artifactTypes?: ArtifactType[];
  keywords?: string[];
  requiredCapabilities?: ProviderCapability[];
  preferredProviders?: string[];
  roleAffinity?: AgentRole[];
  resourceHints?: string[];
  toolHints?: string[];
  promptHints?: string[];
  memoryLayers?: MemoryLayer[];
}

export interface SkillPackRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  skillIds: string[];
  toolHints: string[];
  promptHints: string[];
  memoryLayers: MemoryLayer[];
}

export interface ApprovalPolicyRecord {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  mode: ApprovalPolicyMode;
  priority: number;
  matchTaskTypes: TaskType[];
  matchIntents: TaskIntent[];
  matchArtifactTypes: ArtifactType[];
  matchRunners: Array<"codex" | "gemini">;
  matchKeywords: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRequestRecord {
  id: string;
  taskId?: string | null;
  policyKey?: string | null;
  kind: ApprovalRequestKind;
  status: ApprovalRequestStatus;
  summary: string;
  detail?: string | null;
  runner?: "codex" | "gemini" | null;
  source?: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt?: Date | null;
  decisionNote?: string | null;
}

export interface TaskApprovalPlan {
  mode: ApprovalPolicyMode;
  matchedPolicies: string[];
  reasons: string[];
}

export interface AuditResult {
  decision: AuditDecision;
  riskLevel: TaskRiskLevel;
  issues: string[];
  suggestions: string[];
  rawText: string;
}

export type MonitorEventType =
  | "task.accepted"
  | "task.status_changed"
  | "task.completed"
  | "task.failed"
  | "task.cache_hit"
  | "task.route_selected"
  | "task.skills_selected"
  | "provider.started"
  | "provider.completed"
  | "provider.failed"
  | "audit.required"
  | "audit.passed"
  | "audit.revise_required"
  | "audit.rejected"
  | "role.heartbeat"
  | "config.reloaded"
  | "config.reload_failed";

export interface MonitorEvent {
  id: string;
  type: MonitorEventType;
  timestamp: string;
  taskId?: string;
  provider?: string;
  role?: AgentRole;
  status?: TaskStatus;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface TaskMonitorReport {
  taskId: string;
  type: TaskType;
  status: TaskStatus;
  summary: string | null;
  updatedAt: string;
  rolePlan?: WorkflowRolePlan;
  workflow?: WorkflowMeta;
  lastProvider?: string;
  audit?: {
    required: boolean;
    triggers: AuditTrigger[];
    lastDecision?: AuditDecision;
    revisionRound?: number;
  };
}

export interface AgentHeartbeat {
  role: AgentRole;
  provider?: string;
  seenAt: string;
  state: "idle" | "running" | "waiting" | "error";
  detail?: string;
}

export interface ProviderMonitorReport {
  provider: string;
  totalCalls: number;
  failures: number;
  lastStatus: "idle" | "running" | "success" | "failed";
  lastSeenAt?: string;
}

export interface MonitorDashboardReport {
  generatedAt: string;
  activeTasks: TaskMonitorReport[];
  heartbeats: AgentHeartbeat[];
  providers: ProviderMonitorReport[];
  recentEvents: MonitorEvent[];
}
