import type {
  ApprovalPolicyRecord,
  ApprovalRequestRecord,
  ArtifactType,
  ArtifactExecutionInput,
  ArtifactExecutionResult,
  LocalAccessRequest,
  LocalAccessResult,
  CodingArtifacts,
  CodingHandoffBundle,
  KnowledgeEntryRecord,
  MemoryLayer,
  ProviderHealth,
  ProviderStateStatus,
  TaskListItem,
  TaskRecord,
  TaskStatus,
  TaskSubmission,
  TaskIntent,
  TaskType,
} from "./types";

export interface TaskStore {
  createTask(input: {
    type: TaskType;
    status: TaskStatus;
    source: string;
    sourceMeta?: Record<string, unknown>;
    userInput: string;
    normalizedInput: string;
    summary?: string;
    cacheKey?: string;
  }): Promise<TaskRecord>;
  updateTask(taskId: string, patch: Partial<Omit<TaskRecord, "id" | "steps" | "createdAt">>): Promise<TaskRecord>;
  completeTask(taskId: string, outputSummary: string, result: Record<string, unknown>): Promise<TaskRecord>;
  failTask(
    taskId: string,
    error: string,
    status?: Extract<TaskStatus, "failed" | "needs_manual_login" | "needs_browser_launch" | "provider_session_lost">,
  ): Promise<TaskRecord>;
  addTaskStep(input: {
    taskId: string;
    phase: TaskStatus;
    provider?: string;
    status: "started" | "completed" | "failed";
    inputSummary?: string;
    outputSummary?: string;
    meta?: Record<string, unknown>;
  }): Promise<string>;
  finishTaskStep(
    stepId: string,
    patch: {
      status: "completed" | "failed";
      outputSummary?: string;
      meta?: Record<string, unknown>;
    },
  ): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  listTasks(limit?: number): Promise<TaskListItem[]>;
  listKnowledge(limit?: number): Promise<KnowledgeEntryRecord[]>;
  searchKnowledge(input: {
    query: string;
    limit?: number;
    kinds?: KnowledgeEntryRecord["kind"][];
    layers?: MemoryLayer[];
  }): Promise<KnowledgeEntryRecord[]>;
  upsertKnowledge(input: {
    key: string;
    scope?: string;
    kind: KnowledgeEntryRecord["kind"];
    layer?: MemoryLayer;
    title: string;
    content: string;
    summary?: string;
    tags?: string[];
    importance?: number;
    source?: string;
    sourceTaskId?: string;
    pinned?: boolean;
  }): Promise<KnowledgeEntryRecord>;
  touchKnowledge(entryIds: string[]): Promise<void>;
  listApprovalPolicies(): Promise<ApprovalPolicyRecord[]>;
  upsertApprovalPolicy(input: {
    key: string;
    name: string;
    description?: string;
    enabled?: boolean;
    mode: ApprovalPolicyRecord["mode"];
    priority?: number;
    matchTaskTypes?: TaskType[];
    matchIntents?: TaskIntent[];
    matchArtifactTypes?: ArtifactType[];
    matchRunners?: Array<"codex" | "gemini">;
    matchKeywords?: string[];
  }): Promise<ApprovalPolicyRecord>;
  listApprovalRequests(input?: {
    status?: ApprovalRequestRecord["status"];
    limit?: number;
  }): Promise<ApprovalRequestRecord[]>;
  createApprovalRequest(input: {
    taskId?: string;
    policyKey?: string;
    kind: ApprovalRequestRecord["kind"];
    status?: ApprovalRequestRecord["status"];
    summary: string;
    detail?: string;
    runner?: "codex" | "gemini";
    source?: string;
  }): Promise<ApprovalRequestRecord>;
  resolveApprovalRequest(input: {
    id: string;
    status: Extract<ApprovalRequestRecord["status"], "approved" | "rejected" | "resolved" | "expired">;
    decisionNote?: string;
  }): Promise<ApprovalRequestRecord | null>;
  findPendingApprovalRequestByTask(taskId: string): Promise<ApprovalRequestRecord | null>;
  recordProviderState(input: {
    name: string;
    status: ProviderStateStatus;
    lastError?: string;
    recoveryHint?: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;
  listProviderStates(): Promise<ProviderHealth[]>;
  getCache(key: string): Promise<Record<string, unknown> | null>;
  setCache(key: string, taskType: TaskType, value: Record<string, unknown>): Promise<void>;
}

export interface TaskNotifier {
  notifyTaskAccepted(task: TaskRecord): Promise<void>;
  notifyTaskCompleted(task: TaskRecord): Promise<void>;
  notifyTaskFailed(task: TaskRecord): Promise<void>;
  notifyProviderAttention(provider: string, detail: string, hint?: string): Promise<void>;
}

export interface CodexRunner {
  isAvailable(): Promise<boolean>;
  createArtifacts(bundle: CodingHandoffBundle): Promise<CodingArtifacts>;
  run?(bundle: CodingHandoffBundle, artifacts: CodingArtifacts): Promise<{
    stdout: string;
    stderr: string;
    success: boolean;
    sessionId?: string;
  }>;
  resume?(input: {
    sessionId: string;
    prompt: string;
  }): Promise<{
    stdout: string;
    stderr: string;
    success: boolean;
    sessionId?: string;
  }>;
}

export interface LocalAccessService {
  gatherContext(input: LocalAccessRequest): Promise<LocalAccessResult>;
  createDirectory?(dirPath: string): Promise<{ success: boolean; error?: string }>;
  writeFile?(filePath: string, content: string): Promise<{ success: boolean; error?: string }>;
  moveFile?(srcPath: string, destPath: string): Promise<{ success: boolean; error?: string }>;
}

export interface ArtifactExecutor {
  readonly kind: "doc_markdown" | "ppt_markdown" | "image_prompt" | "video_plan";
  execute(input: ArtifactExecutionInput): Promise<ArtifactExecutionResult>;
}

export interface ExecutionResult {
  task: TaskRecord;
  cached: boolean;
}

export interface TaskExecutor {
  submitTask(submission: TaskSubmission): Promise<{
    taskId: string;
    taskType: TaskType;
  }>;
  executeTask(taskId: string): Promise<TaskRecord>;
}

export interface CopilotBridgeRequest {
  taskId: string;
  prompt: string;
  context?: string;
  mode: "review" | "generate" | "edit";
}

export interface CopilotBridgeResponse {
  output: string;
  model?: string;
  tokensUsed?: number;
  error?: string;
}

export interface CopilotBridge {
  readonly available: boolean;
  sendToCopilot(request: CopilotBridgeRequest): Promise<CopilotBridgeResponse>;
  reviewWithCopilot(taskId: string, content: string, criteria?: string): Promise<CopilotBridgeResponse>;
}
