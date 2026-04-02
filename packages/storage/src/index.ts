import { PrismaClient } from "@prisma/client";
import type {
  ApprovalPolicyRecord,
  ApprovalRequestRecord,
  KnowledgeEntryRecord,
  ProviderHealth,
  TaskListItem,
  TaskRecord,
  TaskStepRecord,
} from "@office-agent/core";
import type { TaskStore } from "@office-agent/core";
import { safeJsonParse } from "@office-agent/core";

function parseTask(record: {
  id: string;
  type: string;
  status: string;
  source: string;
  sourceMetaJson: string | null;
  userInput: string;
  normalizedInput: string;
  summary: string | null;
  outputSummary: string | null;
  resultJson: string | null;
  error: string | null;
  cacheKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  steps?: Array<{
    id: string;
    taskId: string;
    phase: string;
    provider: string | null;
    status: string;
    inputSummary: string | null;
    outputSummary: string | null;
    metaJson: string | null;
    startedAt: Date;
    endedAt: Date | null;
  }>;
}): TaskRecord {
  return {
    id: record.id,
    type: record.type as TaskRecord["type"],
    status: record.status as TaskRecord["status"],
    source: record.source,
    sourceMeta: safeJsonParse(record.sourceMetaJson, null),
    userInput: record.userInput,
    normalizedInput: record.normalizedInput,
    summary: record.summary,
    outputSummary: record.outputSummary,
    result: safeJsonParse(record.resultJson, null),
    error: record.error,
    cacheKey: record.cacheKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    steps: record.steps?.map(parseStep),
  };
}

function parseStep(record: {
  id: string;
  taskId: string;
  phase: string;
  provider: string | null;
  status: string;
  inputSummary: string | null;
  outputSummary: string | null;
  metaJson: string | null;
  startedAt: Date;
  endedAt: Date | null;
}): TaskStepRecord {
  return {
    id: record.id,
    taskId: record.taskId,
    phase: record.phase as TaskStepRecord["phase"],
    provider: record.provider,
    status: record.status as TaskStepRecord["status"],
    inputSummary: record.inputSummary,
    outputSummary: record.outputSummary,
    meta: safeJsonParse(record.metaJson, null),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

function parseKnowledge(record: {
  id: string;
  key: string;
  scope: string;
  kind: string;
  layer: string;
  title: string;
  content: string;
  summary: string | null;
  tagsJson: string | null;
  importance: number;
  source: string | null;
  sourceTaskId: string | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
}): KnowledgeEntryRecord {
  return {
    id: record.id,
    key: record.key,
    scope: record.scope,
    kind: record.kind as KnowledgeEntryRecord["kind"],
    layer: record.layer as KnowledgeEntryRecord["layer"],
    title: record.title,
    content: record.content,
    summary: record.summary,
    tags: safeJsonParse(record.tagsJson, []),
    importance: record.importance,
    source: record.source,
    sourceTaskId: record.sourceTaskId,
    pinned: record.pinned,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAccessedAt: record.lastAccessedAt,
  };
}

function parseApprovalPolicy(record: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  mode: string;
  priority: number;
  matchTaskTypesJson: string | null;
  matchIntentsJson: string | null;
  matchArtifactsJson: string | null;
  matchRunnersJson: string | null;
  matchKeywordsJson: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ApprovalPolicyRecord {
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    description: record.description,
    enabled: record.enabled,
    mode: record.mode as ApprovalPolicyRecord["mode"],
    priority: record.priority,
    matchTaskTypes: safeJsonParse(record.matchTaskTypesJson, []),
    matchIntents: safeJsonParse(record.matchIntentsJson, []),
    matchArtifactTypes: safeJsonParse(record.matchArtifactsJson, []),
    matchRunners: safeJsonParse(record.matchRunnersJson, []),
    matchKeywords: safeJsonParse(record.matchKeywordsJson, []),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseApprovalRequest(record: {
  id: string;
  taskId: string | null;
  policyKey: string | null;
  kind: string;
  status: string;
  summary: string;
  detail: string | null;
  runner: string | null;
  source: string | null;
  decisionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
}): ApprovalRequestRecord {
  return {
    id: record.id,
    taskId: record.taskId,
    policyKey: record.policyKey,
    kind: record.kind as ApprovalRequestRecord["kind"],
    status: record.status as ApprovalRequestRecord["status"],
    summary: record.summary,
    detail: record.detail,
    runner: (record.runner as ApprovalRequestRecord["runner"]) ?? null,
    source: record.source,
    decisionNote: record.decisionNote,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    decidedAt: record.decidedAt,
  };
}

function normalizeKnowledgeText(input: string): string {
  return input.trim().toLowerCase();
}

function tokenizeKnowledgeQuery(input: string): string[] {
  const tokens = normalizeKnowledgeText(input).match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2))];
}

function scoreKnowledgeEntry(entry: KnowledgeEntryRecord, query: string, tokens: string[]): number {
  const title = normalizeKnowledgeText(entry.title);
  const haystack = normalizeKnowledgeText([entry.title, entry.summary ?? "", entry.content, entry.tags.join(" ")].join("\n"));
  const tags = normalizeKnowledgeText(entry.tags.join(" "));
  let score = 0;
  let matched = false;

  if (query && haystack.includes(query)) {
    score += 24;
    matched = true;
  }
  if (query && title.includes(query)) {
    score += 16;
    matched = true;
  }
  if (query && tags.includes(query)) {
    score += 12;
    matched = true;
  }

  for (const token of tokens) {
    if (title.includes(token)) {
      score += 8;
      matched = true;
    }
    if (tags.includes(token)) {
      score += 6;
      matched = true;
    }
    if (haystack.includes(token)) {
      score += 4;
      matched = true;
    }
  }

  if (!matched) {
    return 0;
  }

  if (entry.pinned) {
    score += 10;
  }

  if (entry.kind === "preference") {
    score += 2;
  }

  return score;
}

export class PrismaTaskStore implements TaskStore {
  constructor(private readonly prisma: PrismaClient) {}

  static createClient(): PrismaClient {
    return new PrismaClient();
  }

  async createTask(input: {
    type: TaskRecord["type"];
    status: TaskRecord["status"];
    source: string;
    sourceMeta?: Record<string, unknown>;
    userInput: string;
    normalizedInput: string;
    summary?: string;
    cacheKey?: string;
  }): Promise<TaskRecord> {
    const task = await this.prisma.task.create({
      data: {
        type: input.type,
        status: input.status,
        source: input.source,
        sourceMetaJson: input.sourceMeta ? JSON.stringify(input.sourceMeta) : null,
        userInput: input.userInput,
        normalizedInput: input.normalizedInput,
        summary: input.summary ?? null,
        cacheKey: input.cacheKey ?? null,
      },
    });

    return parseTask(task);
  }

  async updateTask(taskId: string, patch: Partial<Omit<TaskRecord, "id" | "steps" | "createdAt">>): Promise<TaskRecord> {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        type: patch.type,
        status: patch.status,
        source: patch.source,
        sourceMetaJson: patch.sourceMeta ? JSON.stringify(patch.sourceMeta) : undefined,
        userInput: patch.userInput,
        normalizedInput: patch.normalizedInput,
        summary: patch.summary,
        outputSummary: patch.outputSummary,
        resultJson: patch.result ? JSON.stringify(patch.result) : undefined,
        error: patch.error,
        cacheKey: patch.cacheKey,
        completedAt: patch.completedAt,
      },
      include: {
        steps: {
          orderBy: {
            startedAt: "asc",
          },
        },
      },
    });

    return parseTask(task);
  }

  async completeTask(taskId: string, outputSummary: string, result: Record<string, unknown>): Promise<TaskRecord> {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: "completed",
        outputSummary,
        resultJson: JSON.stringify(result),
        completedAt: new Date(),
        error: null,
      },
      include: {
        steps: {
          orderBy: {
            startedAt: "asc",
          },
        },
      },
    });

    return parseTask(task);
  }

  async failTask(
    taskId: string,
    error: string,
    status: "failed" | "needs_manual_login" | "needs_browser_launch" | "provider_session_lost" = "failed",
  ): Promise<TaskRecord> {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status,
        error,
      },
      include: {
        steps: {
          orderBy: {
            startedAt: "asc",
          },
        },
      },
    });

    return parseTask(task);
  }

  async addTaskStep(input: {
    taskId: string;
    phase: TaskRecord["status"];
    provider?: string;
    status: "started" | "completed" | "failed";
    inputSummary?: string;
    outputSummary?: string;
    meta?: Record<string, unknown>;
  }): Promise<string> {
    const step = await this.prisma.taskStep.create({
      data: {
        taskId: input.taskId,
        phase: input.phase,
        provider: input.provider ?? null,
        status: input.status,
        inputSummary: input.inputSummary ?? null,
        outputSummary: input.outputSummary ?? null,
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
        endedAt: input.status === "started" ? null : new Date(),
      },
    });

    return step.id;
  }

  async finishTaskStep(
    stepId: string,
    patch: {
      status: "completed" | "failed";
      outputSummary?: string;
      meta?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.prisma.taskStep.update({
      where: { id: stepId },
      data: {
        status: patch.status,
        outputSummary: patch.outputSummary ?? null,
        metaJson: patch.meta ? JSON.stringify(patch.meta) : null,
        endedAt: new Date(),
      },
    });
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        steps: {
          orderBy: {
            startedAt: "asc",
          },
        },
      },
    });

    return task ? parseTask(task) : null;
  }

  async listTasks(limit = 20): Promise<TaskListItem[]> {
    const tasks = await this.prisma.task.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
    });

    return tasks.map((task) => ({
      id: task.id,
      type: task.type as TaskListItem["type"],
      status: task.status as TaskListItem["status"],
      source: task.source,
      summary: task.summary,
      outputSummary: task.outputSummary,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }));
  }

  async listKnowledge(limit = 20): Promise<KnowledgeEntryRecord[]> {
    const entries = await this.prisma.knowledgeEntry.findMany({
      orderBy: [
        { pinned: "desc" },
        { importance: "desc" },
        { lastAccessedAt: "desc" },
        { updatedAt: "desc" },
      ],
      take: limit,
    });

    return entries.map(parseKnowledge);
  }

  async searchKnowledge(input: {
    query: string;
    limit?: number;
    kinds?: KnowledgeEntryRecord["kind"][];
    layers?: KnowledgeEntryRecord["layer"][];
  }): Promise<KnowledgeEntryRecord[]> {
    const query = normalizeKnowledgeText(input.query);
    const tokens = tokenizeKnowledgeQuery(input.query);
    const entries = await this.prisma.knowledgeEntry.findMany({
      where: {
        ...(input.kinds?.length
          ? {
              kind: {
                in: input.kinds,
              },
            }
          : {}),
        ...(input.layers?.length
          ? {
              layer: {
                in: input.layers,
              },
            }
          : {}),
      },
      orderBy: [
        { pinned: "desc" },
        { importance: "desc" },
        { updatedAt: "desc" },
      ],
      take: 200,
    });

    const parsed = entries.map(parseKnowledge);
    if (!query && tokens.length === 0) {
      return parsed.slice(0, input.limit ?? 8);
    }

    const ranked = parsed
      .map((entry) => ({
        entry,
        score: scoreKnowledgeEntry(entry, query, tokens),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entry.updatedAt.getTime() - left.entry.updatedAt.getTime();
      })
      .slice(0, input.limit ?? 8)
      .map((entry) => entry.entry);

    if (ranked.length > 0) {
      return ranked;
    }

    return query || tokens.length > 0 ? [] : parsed.slice(0, input.limit ?? 8);
  }

  async upsertKnowledge(input: {
    key: string;
    scope?: string;
    kind: KnowledgeEntryRecord["kind"];
    layer?: KnowledgeEntryRecord["layer"];
    title: string;
    content: string;
    summary?: string;
    tags?: string[];
    importance?: number;
    source?: string;
    sourceTaskId?: string;
    pinned?: boolean;
  }): Promise<KnowledgeEntryRecord> {
    const entry = await this.prisma.knowledgeEntry.upsert({
      where: { key: input.key },
      update: {
        scope: input.scope ?? "global",
        kind: input.kind,
        layer: input.layer ?? "long_term",
        title: input.title,
        content: input.content,
        summary: input.summary ?? null,
        tagsJson: JSON.stringify(input.tags ?? []),
        importance: input.importance ?? 50,
        source: input.source ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        pinned: input.pinned ?? false,
      },
      create: {
        key: input.key,
        scope: input.scope ?? "global",
        kind: input.kind,
        layer: input.layer ?? "long_term",
        title: input.title,
        content: input.content,
        summary: input.summary ?? null,
        tagsJson: JSON.stringify(input.tags ?? []),
        importance: input.importance ?? 50,
        source: input.source ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        pinned: input.pinned ?? false,
      },
    });

    return parseKnowledge(entry);
  }

  async touchKnowledge(entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }

    await this.prisma.knowledgeEntry.updateMany({
      where: {
        id: {
          in: entryIds,
        },
      },
      data: {
        lastAccessedAt: new Date(),
      },
    });
  }

  async listApprovalPolicies(): Promise<ApprovalPolicyRecord[]> {
    const entries = await this.prisma.approvalPolicy.findMany({
      orderBy: [
        { priority: "asc" },
        { createdAt: "asc" },
      ],
    });

    return entries.map(parseApprovalPolicy);
  }

  async upsertApprovalPolicy(input: {
    key: string;
    name: string;
    description?: string;
    enabled?: boolean;
    mode: ApprovalPolicyRecord["mode"];
    priority?: number;
    matchTaskTypes?: ApprovalPolicyRecord["matchTaskTypes"];
    matchIntents?: ApprovalPolicyRecord["matchIntents"];
    matchArtifactTypes?: ApprovalPolicyRecord["matchArtifactTypes"];
    matchRunners?: ApprovalPolicyRecord["matchRunners"];
    matchKeywords?: string[];
  }): Promise<ApprovalPolicyRecord> {
    const entry = await this.prisma.approvalPolicy.upsert({
      where: { key: input.key },
      update: {
        name: input.name,
        description: input.description ?? null,
        enabled: input.enabled ?? true,
        mode: input.mode,
        priority: input.priority ?? 100,
        matchTaskTypesJson: JSON.stringify(input.matchTaskTypes ?? []),
        matchIntentsJson: JSON.stringify(input.matchIntents ?? []),
        matchArtifactsJson: JSON.stringify(input.matchArtifactTypes ?? []),
        matchRunnersJson: JSON.stringify(input.matchRunners ?? []),
        matchKeywordsJson: JSON.stringify(input.matchKeywords ?? []),
      },
      create: {
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        enabled: input.enabled ?? true,
        mode: input.mode,
        priority: input.priority ?? 100,
        matchTaskTypesJson: JSON.stringify(input.matchTaskTypes ?? []),
        matchIntentsJson: JSON.stringify(input.matchIntents ?? []),
        matchArtifactsJson: JSON.stringify(input.matchArtifactTypes ?? []),
        matchRunnersJson: JSON.stringify(input.matchRunners ?? []),
        matchKeywordsJson: JSON.stringify(input.matchKeywords ?? []),
      },
    });

    return parseApprovalPolicy(entry);
  }

  async listApprovalRequests(input?: {
    status?: ApprovalRequestRecord["status"];
    limit?: number;
  }): Promise<ApprovalRequestRecord[]> {
    const entries = await this.prisma.approvalRequest.findMany({
      where: input?.status ? { status: input.status } : undefined,
      orderBy: [
        { createdAt: "desc" },
      ],
      take: input?.limit ?? 50,
    });

    return entries.map(parseApprovalRequest);
  }

  async createApprovalRequest(input: {
    taskId?: string;
    policyKey?: string;
    kind: ApprovalRequestRecord["kind"];
    status?: ApprovalRequestRecord["status"];
    summary: string;
    detail?: string;
    runner?: "codex" | "gemini";
    source?: string;
  }): Promise<ApprovalRequestRecord> {
    const entry = await this.prisma.approvalRequest.create({
      data: {
        taskId: input.taskId ?? null,
        policyKey: input.policyKey ?? null,
        kind: input.kind,
        status: input.status ?? "pending",
        summary: input.summary,
        detail: input.detail ?? null,
        runner: input.runner ?? null,
        source: input.source ?? null,
      },
    });

    return parseApprovalRequest(entry);
  }

  async resolveApprovalRequest(input: {
    id: string;
    status: Extract<ApprovalRequestRecord["status"], "approved" | "rejected" | "resolved" | "expired">;
    decisionNote?: string;
  }): Promise<ApprovalRequestRecord | null> {
    try {
      const entry = await this.prisma.approvalRequest.update({
        where: { id: input.id },
        data: {
          status: input.status,
          decisionNote: input.decisionNote ?? null,
          decidedAt: new Date(),
        },
      });
      return parseApprovalRequest(entry);
    } catch {
      return null;
    }
  }

  async findPendingApprovalRequestByTask(taskId: string): Promise<ApprovalRequestRecord | null> {
    const entry = await this.prisma.approvalRequest.findFirst({
      where: {
        taskId,
        status: "pending",
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return entry ? parseApprovalRequest(entry) : null;
  }

  async recordProviderState(input: {
    name: string;
    status: ProviderHealth["status"];
    lastError?: string;
    recoveryHint?: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.providerState.upsert({
      where: { name: input.name },
      update: {
        status: input.status,
        lastError: input.lastError ?? null,
        recoveryHint: input.recoveryHint ?? null,
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
        checkedAt: new Date(),
      },
      create: {
        name: input.name,
        status: input.status,
        lastError: input.lastError ?? null,
        recoveryHint: input.recoveryHint ?? null,
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
      },
    });
  }

  async listProviderStates(): Promise<ProviderHealth[]> {
    const states = await this.prisma.providerState.findMany({
      orderBy: {
        name: "asc",
      },
    });

    return states.map((state) => ({
      provider: state.name,
      status: state.status as ProviderHealth["status"],
      detail: state.lastError ?? state.status,
      checkedAt: state.checkedAt,
      recoveryHint: state.recoveryHint ?? undefined,
      meta: safeJsonParse(state.metaJson, {}),
    }));
  }

  async getCache(key: string): Promise<Record<string, unknown> | null> {
    const entry = await this.prisma.cacheEntry.findUnique({
      where: { key },
    });

    return entry ? safeJsonParse(entry.valueJson, null) : null;
  }

  async setCache(key: string, taskType: TaskRecord["type"], value: Record<string, unknown>): Promise<void> {
    await this.prisma.cacheEntry.upsert({
      where: { key },
      update: {
        taskType,
        valueJson: JSON.stringify(value),
      },
      create: {
        key,
        taskType,
        valueJson: JSON.stringify(value),
      },
    });
  }
}
