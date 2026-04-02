import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushScheduler } from "../apps/server/src/scheduler";
import { LocalCodexRunner } from "../packages/codex-runner/src/index";
import { TaskOrchestrator } from "../packages/core/src/orchestrator";
import { FeishuBotApp } from "../packages/integrations/feishu/src/index";
import { PrismaTaskStore } from "../packages/storage/src/index";
import type { CodingArtifacts, CodingHandoffBundle, KnowledgeEntryRecord, TaskRecord, WorkflowMeta } from "../packages/core/src/types";

describe("regressions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function createWorkflowMeta(overrides: Partial<WorkflowMeta> = {}): WorkflowMeta {
    return {
      tier: "T2",
      intent: "qa",
      budget: "standard",
      artifactType: "none",
      qualityLevel: "standard",
      riskLevel: "low",
      complexity: "easy",
      complexityScore: 0.2,
      audit: {
        requested: false,
        required: false,
        triggers: [],
        strategy: "structured_gate",
        maxRevisionRounds: 1,
      },
      selectedSkills: [],
      ...overrides,
    };
  }

  function createTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
    const workflow = createWorkflowMeta();
    const baseTask: TaskRecord = {
      id: "task_regression",
      type: "SIMPLE",
      status: "completed",
      source: "feishu",
      sourceMeta: {
        workflow,
      },
      userInput: "back bone是什么意思",
      normalizedInput: "back bone是什么意思",
      summary: "back bone是什么意思",
      outputSummary: "back bone 是什么意思",
      result: {
        answer: "back bone 是什么意思",
      },
      error: null,
      cacheKey: "cache",
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
      steps: [],
    };

    return {
      ...baseTask,
      ...overrides,
      sourceMeta: {
        workflow,
        ...((overrides.sourceMeta as Record<string, unknown> | undefined) ?? {}),
      },
    };
  }

  function createKnowledgeEntry(overrides: Partial<KnowledgeEntryRecord> = {}): KnowledgeEntryRecord {
    return {
      id: "knowledge_entry",
      key: "knowledge:key",
      scope: "global",
      kind: "task_history",
      layer: "episodic",
      title: "backbone是什么意思",
      content: "backbone 常见意思是骨干、主干，也可指支柱。",
      summary: "backbone 常见意思是骨干、主干，也可指支柱。",
      tags: ["simple", "qa", "backbone是什么意思"],
      importance: 60,
      source: "feishu",
      sourceTaskId: "task_backbone",
      pinned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: null,
      ...overrides,
    };
  }

  function stubGitHubTrendingFetch(overrides: Partial<Record<string, unknown>> = {}) {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("api.github.com/search/repositories")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }

      return {
        ok: true,
        json: async () => ({
          items: [
            {
              full_name: "acme/frontier-agent",
              html_url: "https://github.com/acme/frontier-agent",
              description: "An AI agent project for robotics and autonomous workflows.",
              language: "TypeScript",
              stargazers_count: 3210,
              topics: ["ai", "robotics", "agent"],
            },
          ],
          ...overrides,
        }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("keeps explicit Codex runner even if local context mentions gemini", async () => {
    const runner = new LocalCodexRunner({
      enabled: true,
      mode: "cli",
      command: "bash",
      args: [],
      gemini: {
        enabled: true,
        command: "definitely-missing-gemini-cli",
        args: [],
      },
      artifactRootDir: "/tmp",
      workspaceRoot: "/tmp",
    });

    const bundle: CodingHandoffBundle = {
      taskId: "task_codex_prefers_explicit_runner",
      originalRequest: "请用 codex 帮我看下为什么中午报了三次",
      explicitRunner: "codex",
      candidatePlans: [
        {
          provider: "direct_to_codex",
          plan: "直接交给 Codex 在本地分析。",
        },
      ],
      finalPlan: "本地上下文里提到了 gemini CLI 不可用，但这次仍然必须由 Codex 执行。",
      risks: [],
      impactedFiles: [],
      testingSuggestions: [],
      unresolvedQuestions: [],
    };

    const resolved = await (runner as unknown as { resolveRunner: (input: CodingHandoffBundle) => Promise<{ kind: string } | null> }).resolveRunner(bundle);
    expect(resolved?.kind).toBe("codex");
  });

  it("does not inject recent or prompt-polluted memory into simple qa context", async () => {
    const searchKnowledge = vi.fn(async ({ layers }: { layers?: string[] }) => {
      if (layers?.includes("episodic")) {
        return [
          createKnowledgeEntry({
            id: "polluted_backbone",
            summary: "请直接用中文简洁回答用户问题。用户问题：不要。本地上下文摘要：(来源: layered_memory) 分层记忆摘要：...",
            content: "请直接用中文简洁回答用户问题。用户问题：不要。本地上下文摘要：(来源: layered_memory) 分层记忆摘要：...",
          }),
        ];
      }
      return [];
    });

    const listKnowledge = vi.fn(async () => [
      createKnowledgeEntry({
        id: "recent_noon_brief",
        layer: "long_term",
        title: "请输出一份简洁的今日午报",
        summary: "2026年3月30日 午报",
        content: "这是一条与 backbone 无关的偏好。",
        tags: ["scheduler", "午报"],
        pinned: true,
      }),
    ]);

    const store = {
      searchKnowledge,
      listKnowledge,
      touchKnowledge: vi.fn(),
    };

    const orchestrator = new TaskOrchestrator(
      store as never,
      { list: () => [] } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      [],
    );

    const context = await (orchestrator as unknown as {
      loadSharedKnowledgeContext: (task: TaskRecord) => Promise<{ summary: string } | null>;
    }).loadSharedKnowledgeContext(createTaskRecord());

    expect(context).toBeNull();
    expect(listKnowledge).not.toHaveBeenCalled();
    expect(store.touchKnowledge).not.toHaveBeenCalled();
  });

  it("does not fall back to unrelated knowledge when a query has no matches", async () => {
    const prisma = {
      knowledgeEntry: {
        findMany: vi.fn(async () => [
          {
            id: "knowledge_recent",
            key: "task:recent",
            scope: "global",
            kind: "task_history",
            layer: "episodic",
            title: "请输出一份简洁的今日午报",
            content: "这是一条和 backbone 无关的最近偏好。",
            summary: "2026年3月30日 午报",
            tagsJson: JSON.stringify(["scheduler", "午报"]),
            importance: 80,
            source: "scheduler",
            sourceTaskId: "task_scheduler",
            pinned: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            lastAccessedAt: null,
          },
        ]),
      },
    };

    const store = new PrismaTaskStore(prisma as never);
    const results = await store.searchKnowledge({
      query: "backbone是什么意思",
      limit: 4,
      layers: ["episodic"],
    });

    expect(results).toEqual([]);
  });

  it("rejects provider output that leaks prompt scaffolding and context blocks", async () => {
    let task = createTaskRecord({
      status: "drafting",
      completedAt: null,
    });

    const store = {
      updateTask: vi.fn(async (_taskId: string, patch: Partial<TaskRecord>) => {
        task = {
          ...task,
          ...patch,
          updatedAt: new Date(),
        };
        return task;
      }),
      addTaskStep: vi.fn(async () => "step_1"),
      finishTaskStep: vi.fn(async () => undefined),
      recordProviderState: vi.fn(async () => undefined),
    };

    const provider = {
      name: "mock_provider",
      ensureSession: vi.fn(async () => ({
        ok: true,
        detail: "ok",
      })),
      manualRecoveryHint: vi.fn(() => "relogin"),
      sendPrompt: vi.fn(async () => ({ id: "run_1" })),
      waitForCompletion: vi.fn(async () => ({ id: "completion_1" })),
      extractAnswer: vi.fn(async () => ({
        provider: "mock_provider",
        outputText: [
          "请直接用中文简洁回答用户问题，不要解释你的角色，不要重复问题。",
          "用户问题：back bone是什么意思",
          "本地上下文摘要：",
          "(来源: layered_memory)",
          "分层记忆摘要：以下内容来自系统共享知识库。",
        ].join("\n"),
        summary: "polluted",
      })),
      screenshotOnFailure: vi.fn(async () => undefined),
    };

    const orchestrator = new TaskOrchestrator(
      store as never,
      {
        get: () => provider,
        list: () => [provider],
      } as never,
      {} as never,
      {} as never,
      {
        notifyProviderAttention: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      [],
    );

    await expect((orchestrator as unknown as {
      runProviderPhase: (
        task: TaskRecord,
        target: { role: "zhongshu_drafter"; provider: string; preset: "standard"; timeoutMs: number },
        phaseStatus: "drafting",
        prompt: string,
      ) => Promise<unknown>;
    }).runProviderPhase(
      task,
      {
        role: "zhongshu_drafter",
        provider: "mock_provider",
        preset: "standard",
        timeoutMs: 30_000,
      },
      "drafting",
      "用户输入：back bone是什么意思\n要求：直接回答",
    )).rejects.toThrow("prompt/template echo");

    expect(store.finishTaskStep).toHaveBeenCalledWith(
      "step_1",
      expect.objectContaining({
        status: "failed",
      }),
    );
  });

  it("does not persist prompt-polluted answers into knowledge", async () => {
    const store = {
      upsertKnowledge: vi.fn(),
    };

    const orchestrator = new TaskOrchestrator(
      store as never,
      { list: () => [] } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      [],
    );

    await (orchestrator as unknown as {
      persistKnowledgeFromTask: (task: TaskRecord) => Promise<void>;
    }).persistKnowledgeFromTask(createTaskRecord({
      result: {
        answer: [
          "请直接用中文简洁回答用户问题，不要解释你的角色，不要重复问题。",
          "如果网页需要人工恢复登录，只输出“需要人工恢复登录”。",
          "用户问题：不要",
          "本地上下文摘要：",
          "(来源: layered_memory)",
          "分层记忆摘要：以下内容来自系统共享知识库。",
        ].join("\n"),
      },
      outputSummary: "坏答案",
    }));

    expect(store.upsertKnowledge).not.toHaveBeenCalled();
  });

  it("skips duplicate noon bulletin when a scheduler task for the slot already exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T04:00:20.000Z"));

    const submitTask = vi.fn();
    const pushTextToChat = vi.fn();
    const store = {
      listTasks: vi.fn().mockResolvedValue([{ id: "existing-hot-topic-task" }]),
      getTask: vi.fn().mockImplementation(async (id: string) => {
        if (id !== "existing-hot-topic-task") {
          return null;
        }
        return {
          id,
          source: "scheduler",
          sourceMeta: {
            schedulerKind: "daily_hot_topics",
            scheduledAt: "2026-03-28 12:00",
          },
        } as unknown as TaskRecord;
      }),
    };

    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile: "/tmp/iai-scheduler-regression-state.json",
          hotTopics: {
            enabled: true,
            times: ["12:00"],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: false,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {
        submitTask,
      } as never,
      store as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    await (scheduler as unknown as { tickHotTopics: () => Promise<void> }).tickHotTopics();

    expect(submitTask).not.toHaveBeenCalled();
    expect(pushTextToChat).not.toHaveBeenCalled();
  });

  it("skips duplicate bulletin when the slot lock already exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T04:00:20.000Z"));

    const stateDir = await mkdtemp(join(tmpdir(), "iai-scheduler-slot-lock-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    await writeFile(
      `${stateFile}.2026-03-28_12_00.slot`,
      JSON.stringify({ pid: 999999, slot: "2026-03-28 12:00" }),
      "utf8",
    );

    const submitTask = vi.fn();
    const pushTextToChat = vi.fn();
    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: true,
            times: ["12:00"],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: false,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {
        submitTask,
      } as never,
      {
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn().mockResolvedValue(null),
      } as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    await (scheduler as unknown as { tickHotTopics: () => Promise<void> }).tickHotTopics();

    expect(submitTask).not.toHaveBeenCalled();
    expect(pushTextToChat).not.toHaveBeenCalled();

    await rm(stateDir, { recursive: true, force: true });
  });

  it("submits hot topic digests with standard quality to avoid unnecessary audit rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T04:00:20.000Z"));
    stubGitHubTrendingFetch();

    const stateDir = await mkdtemp(join(tmpdir(), "iai-scheduler-hot-topics-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    const submitTask = vi.fn().mockResolvedValue({ taskId: "task_hot_topics", taskType: "COMPLEX" });
    const pushTextToChat = vi.fn();
    const completedTask = createTaskRecord({
      id: "task_hot_topics",
      type: "COMPLEX",
      status: "completed",
      source: "scheduler",
      sourceMeta: {
        schedulerKind: "daily_hot_topics",
        scheduledAt: "2026-03-28 12:00",
      },
      result: {
        answer: "12:00 前沿快讯\nAI / 大模型：暂无高信号更新",
        provider: "deepseek_web",
      },
      outputSummary: "12:00 前沿快讯",
    });

    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: true,
            times: ["12:00"],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: false,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {
        submitTask,
      } as never,
      {
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn(async (taskId: string) => taskId === "task_hot_topics" ? completedTask : null),
      } as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    await (scheduler as unknown as { tickHotTopics: () => Promise<void> }).tickHotTopics();

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(submitTask.mock.calls[0]?.[0]?.qualityLevel).toBe("standard");
    expect(String(submitTask.mock.calls[0]?.[0]?.input ?? "")).toContain("【近24小时】");
    expect(String(submitTask.mock.calls[0]?.[0]?.input ?? "")).toContain("GitHub Releases");
    expect(pushTextToChat).toHaveBeenCalledTimes(1);
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).toContain("GitHub 热门项目：acme/frontier-agent");
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).toContain("简介：An AI agent project for robotics and autonomous workflows.");
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).toContain("链接：https://github.com/acme/frontier-agent");
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).not.toContain("12:00 前沿快讯\n12:00 前沿快讯");

    await rm(stateDir, { recursive: true, force: true });
  });

  it("does not delete an unreadable process lock file during concurrent startup", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "iai-scheduler-process-lock-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    const lockFile = `${stateFile}.lock`;
    await writeFile(lockFile, "{\"pid\":", "utf8");

    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: false,
            times: [],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: false,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    const acquired = await (scheduler as unknown as { acquireProcessLock: () => Promise<boolean> }).acquireProcessLock();

    expect(acquired).toBe(false);
    await expect(writeFile(lockFile, "{\"pid\":123}", "utf8")).resolves.toBeUndefined();

    await rm(stateDir, { recursive: true, force: true });
  });

  it("reuses the last inferred feishu chat id for later scheduler pushes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "iai-scheduler-chat-cache-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    const listTasks = vi.fn()
      .mockResolvedValueOnce([{ id: "feishu_task_1" }])
      .mockResolvedValueOnce([]);
    const getTask = vi.fn(async (taskId: string) => {
      if (taskId !== "feishu_task_1") {
        return null;
      }
      return {
        id: taskId,
        source: "feishu",
        sourceMeta: {
          chatId: "chat_cached_123",
        },
      } as unknown as TaskRecord;
    });
    const pushTextToChat = vi.fn();

    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: false,
            times: [],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: false,
          },
        },
        feishu: {},
      } as never,
      {} as never,
      {
        listTasks,
        getTask,
      } as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    await (scheduler as unknown as { pushText: (text: string) => Promise<void> }).pushText("first push");
    await (scheduler as unknown as { pushText: (text: string) => Promise<void> }).pushText("second push");

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(pushTextToChat).toHaveBeenNthCalledWith(1, "chat_cached_123", "first push");
    expect(pushTextToChat).toHaveBeenNthCalledWith(2, "chat_cached_123", "second push");

    await rm(stateDir, { recursive: true, force: true });
  });

  it("turns read-only Codex write attempts into authorization pending instead of completed", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "iai-direct-codex-"));
    await mkdir(taskDir, { recursive: true });

    let task: TaskRecord = {
      id: "task_direct_codex_authorization",
      type: "CODING",
      status: "queued",
      source: "feishu",
      sourceMeta: {
        chatId: "chat_123",
        routeOverrides: {
          autoRunCodex: true,
          directToCodex: true,
          directCliRunner: "codex",
        },
      },
      userInput: "帮我修复下这个bug",
      normalizedInput: "帮我修复下这个bug",
      summary: "帮我修复下这个bug",
      outputSummary: null,
      result: null,
      error: null,
      cacheKey: "cache",
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      steps: [],
    };

    const approvals: Array<Record<string, unknown>> = [];
    const store = {
      updateTask: vi.fn(async (_taskId: string, patch: Partial<TaskRecord>) => {
        task = {
          ...task,
          ...patch,
          updatedAt: new Date(),
        };
        return task;
      }),
      getTask: vi.fn(async () => task),
      findPendingApprovalRequestByTask: vi.fn(async () => null),
      createApprovalRequest: vi.fn(async (input: Record<string, unknown>) => {
        approvals.push(input);
        return {
          id: "approval_1",
          taskId: task.id,
          status: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...input,
        };
      }),
      completeTask: vi.fn(async () => {
        throw new Error("completeTask should not be called for permission-limited direct Codex runs");
      }),
      failTask: vi.fn(async () => {
        throw new Error("failTask should not be called for permission-limited direct Codex runs");
      }),
    };

    const notifier = {
      notifyTaskAccepted: vi.fn(),
      notifyTaskCompleted: vi.fn(),
      notifyTaskFailed: vi.fn(),
      notifyProviderAttention: vi.fn(),
    };

    const codexRunner = {
      isAvailable: vi.fn(async () => true),
      createArtifacts: vi.fn(async (): Promise<CodingArtifacts> => ({
        taskDir,
        implementationBriefPath: join(taskDir, "implementation_brief.md"),
        implementationPlanPath: join(taskDir, "implementation_plan.json"),
        acceptanceChecklistPath: join(taskDir, "acceptance_checklist.md"),
        contextSummaryPath: join(taskDir, "context_summary.md"),
        codexTaskPath: join(taskDir, "codex_task.md"),
      })),
      run: vi.fn(async () => ({
        stdout: "仓库写入仍然被只读策略拦住，apply_patch 被策略拒绝，报了 permission denied / EACCES。",
        stderr: "",
        success: true,
        sessionId: "session_123",
      })),
    };

    const orchestrator = new TaskOrchestrator(
      store as never,
      { list: () => [] } as never,
      {} as never,
      {} as never,
      notifier as never,
      codexRunner as never,
      {} as never,
      [],
    );

    const workflow: WorkflowMeta = {
      tier: "T2",
      intent: "coding",
      budget: "standard",
      artifactType: "none",
      qualityLevel: "standard",
      riskLevel: "low",
      complexity: "easy",
      complexityScore: 0.2,
      audit: {
        requested: false,
        required: false,
        triggers: [],
        strategy: "structured_gate",
        maxRevisionRounds: 1,
      },
      selectedSkills: [],
    };

    const result = await (orchestrator as unknown as {
      executeDirectCodexHandoff: (
        task: TaskRecord,
        workflow: WorkflowMeta,
        route: { autoRunCodex: boolean },
        localContext: { summary: string; backend: string } | null,
      ) => Promise<TaskRecord>;
    }).executeDirectCodexHandoff(task, workflow, { autoRunCodex: true }, null);

    expect(result.status).toBe("needs_human_intervention");
    expect(result.error).toContain("需要额外授权");
    expect((result.result as Record<string, unknown>).authorizationPending).toBe(true);
    expect(store.completeTask).not.toHaveBeenCalled();
    expect(approvals).toHaveLength(1);
    expect(notifier.notifyTaskFailed).toHaveBeenCalled();

    await rm(taskDir, { recursive: true, force: true });
  });

  it("does not force read-only sandbox for direct Codex fix tasks", async () => {
    const runnerDir = await mkdtemp(join(tmpdir(), "iai-codex-runner-"));
    const commandPath = join(runnerDir, "fake-codex.sh");
    const argsPath = join(runnerDir, "args.log");
    const promptPath = join(runnerDir, "prompt.log");
    const artifactDir = join(runnerDir, "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      commandPath,
      `#!/usr/bin/env bash
printf '%s\n' "$@" > "${argsPath}"
cat > "${promptPath}"
printf '{"type":"thread.started","thread_id":"thread_1"}\n'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"已完成修改"}}\n'
`,
      "utf8",
    );
    await chmod(commandPath, 0o755);

    const codexTaskPath = join(artifactDir, "codex_task.md");
    await writeFile(codexTaskPath, "请直接修复这个 bug 并修改代码。", "utf8");

    const runner = new LocalCodexRunner({
      enabled: true,
      mode: "cli",
      command: commandPath,
      args: [],
      artifactRootDir: artifactDir,
      workspaceRoot: runnerDir,
    });

    const bundle: CodingHandoffBundle = {
      taskId: "task_codex_fix_write_enabled",
      originalRequest: "请用 codex 直接修复这个 bug，并真正修改仓库里的代码。",
      explicitRunner: "codex",
      candidatePlans: [
        {
          provider: "direct_to_codex",
          plan: "直接执行修复并落盘。",
        },
      ],
      finalPlan: "直接修改代码并运行必要验证。",
      risks: [],
      impactedFiles: [],
      testingSuggestions: [],
      unresolvedQuestions: [],
    };

    await runner.run(bundle, {
      taskDir: artifactDir,
      implementationBriefPath: join(artifactDir, "implementation_brief.md"),
      implementationPlanPath: join(artifactDir, "implementation_plan.json"),
      acceptanceChecklistPath: join(artifactDir, "acceptance_checklist.md"),
      contextSummaryPath: join(artifactDir, "context_summary.md"),
      codexTaskPath,
    });

    const args = (await readFile(argsPath, "utf8")).split("\n").filter(Boolean);
    expect(args).not.toContain("-s");
    expect(args).not.toContain("read-only");

    await rm(runnerDir, { recursive: true, force: true });
  });

  it("suppresses duplicate weather alerts when forecast details jitter within the same event window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T00:30:00.000Z"));

    const stateDir = await mkdtemp(join(tmpdir(), "iai-weather-dedupe-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    const pushTextToChat = vi.fn();
    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: false,
            times: [],
          },
          weather: {
            enabled: true,
            location: "合肥",
            latitude: 31.82,
            longitude: 117.22,
            checkIntervalMinutes: 30,
            alertWindowHours: 6,
          },
          gold: {
            enabled: false,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {} as never,
      {
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn().mockResolvedValue(null),
      } as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    const forecastA = {
      hourly: {
        time: [
          "2026-03-29T08:00:00+08:00",
          "2026-03-29T09:00:00+08:00",
          "2026-03-29T10:00:00+08:00",
          "2026-03-29T11:00:00+08:00",
          "2026-03-29T12:00:00+08:00",
        ],
        temperature_2m: [26, 27, 27, 23, 22],
        precipitation_probability: [10, 15, 30, 72, 75],
        weather_code: [0, 1, 2, 61, 63],
        wind_speed_10m: [10, 12, 14, 18, 20],
      },
    };
    const forecastB = {
      hourly: {
        time: [
          "2026-03-29T08:00:00+08:00",
          "2026-03-29T09:00:00+08:00",
          "2026-03-29T10:00:00+08:00",
          "2026-03-29T11:00:00+08:00",
          "2026-03-29T12:00:00+08:00",
        ],
        temperature_2m: [26, 27, 27, 24, 23],
        precipitation_probability: [10, 18, 35, 55, 74],
        weather_code: [0, 1, 2, 2, 61],
        wind_speed_10m: [10, 12, 14, 18, 20],
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(forecastA), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify(forecastB), { status: 200, headers: { "content-type": "application/json" } })),
    );

    await (scheduler as unknown as { checkWeatherAlerts: () => Promise<void> }).checkWeatherAlerts();
    await (scheduler as unknown as { checkWeatherAlerts: () => Promise<void> }).checkWeatherAlerts();

    expect(pushTextToChat).toHaveBeenCalledTimes(1);

    await rm(stateDir, { recursive: true, force: true });
  });

  it("starts gold monitoring and sends threshold alerts without requiring Alpha Vantage credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T00:30:00.000Z"));

    const stateDir = await mkdtemp(join(tmpdir(), "iai-gold-alerts-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    const pushTextToChat = vi.fn();
    const warn = vi.fn();
    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: false,
            times: [],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: true,
            checkIntervalMinutes: 120,
            thresholdCny: 20,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {} as never,
      {
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn().mockResolvedValue(null),
      } as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ price: 3_000 }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ rate: 7.2 }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ price: 3_100 }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ rate: 7.2 }), { status: 200, headers: { "content-type": "application/json" } })),
    );

    await (scheduler as unknown as { checkGoldAlerts: () => Promise<void> }).checkGoldAlerts();
    await (scheduler as unknown as { checkGoldAlerts: () => Promise<void> }).checkGoldAlerts();

    expect(pushTextToChat).toHaveBeenCalledTimes(2);
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).toContain("金价监测已启动");
    expect(String(pushTextToChat.mock.calls[1]?.[1] ?? "")).toContain("金价提醒");
    expect(String(pushTextToChat.mock.calls[1]?.[1] ?? "")).toContain("已超过阈值 20 元/克");
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ feature: "gold_alert" }),
      expect.stringContaining("ALPHA_VANTAGE_API_KEY"),
    );

    await rm(stateDir, { recursive: true, force: true });
  });

  it("does not push gold alerts when the replacement quote source returns invalid payloads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T00:30:00.000Z"));

    const stateDir = await mkdtemp(join(tmpdir(), "iai-gold-alert-errors-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    const pushTextToChat = vi.fn();
    const warn = vi.fn();
    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: false,
            times: [],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: true,
            checkIntervalMinutes: 120,
            thresholdCny: 20,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {} as never,
      {
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn().mockResolvedValue(null),
      } as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ price: "n/a" }), { status: 200, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ price: "n/a" }), { status: 200, headers: { "content-type": "application/json" } })),
    );

    await (scheduler as unknown as { checkGoldAlerts: () => Promise<void> }).checkGoldAlerts();

    expect(pushTextToChat).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
      }),
      "Gold alert check failed",
    );

    await rm(stateDir, { recursive: true, force: true });
  });

  it("keeps coding completion replies concise without truncated markers", async () => {
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask: vi.fn(),
      },
      {} as never,
      {},
    );
    const sendCardToChat = vi.fn();
    (bot as unknown as { sendCardToChat: typeof sendCardToChat }).sendCardToChat = sendCardToChat;

    const task: TaskRecord = {
      id: "task_feishu_conclusion",
      type: "CODING",
      status: "completed",
      source: "feishu",
      sourceMeta: {
        chatId: "chat_123",
        workflow: {
          intent: "coding",
        },
      },
      userInput: "帮我修一下天气预报重复推送",
      normalizedInput: "帮我修一下天气预报重复推送",
      summary: "帮我修一下天气预报重复推送",
      outputSummary: "已处理完成",
      result: {
        answer: "这是一个非常长的执行说明。".repeat(120),
        provider: "codex_runner",
        artifacts: [
          {
            path: "/tmp/scheduler.ts",
          },
        ],
      },
      error: null,
      cacheKey: "cache",
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
      steps: [],
    };

    await bot.replyTaskResult(task);

    const card = sendCardToChat.mock.calls[0]?.[1] as Record<string, unknown>;
    const elements = Array.isArray(card?.elements) ? (card.elements as Array<Record<string, unknown>>) : [];
    const summary = String((elements[0] as Record<string, unknown>)?.content ?? "");
    const panel = elements.find((element) => element.tag === "collapsible_panel") as Record<string, unknown> | undefined;

    expect(summary).toContain("结论：问题已处理，代码已经完成修改。");
    expect(summary).toContain("产物：scheduler.ts");
    expect(summary).not.toContain("[truncated");
    expect(panel?.tag).toBe("collapsible_panel");
    expect(panel?.expanded).toBe(false);
  });

  it("submits simple Feishu questions directly without asking for audit confirmation first", async () => {
    const submitTask = vi.fn().mockResolvedValue({ taskId: "task_backbone", taskType: "SIMPLE" });
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask,
      },
      {} as never,
      {},
    );
    const replyToMessage = vi.fn();
    (bot as unknown as { replyToMessage: typeof replyToMessage }).replyToMessage = replyToMessage;

    await (bot as unknown as {
      handleIncomingMessageEvent: (event: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessageEvent({
      message: {
        message_id: "message_backbone",
        chat_id: "chat_123",
        content: JSON.stringify({ text: "backbone什么意思" }),
      },
      sender: {
        sender_id: {
          open_id: "open_123",
        },
      },
    });

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(submitTask.mock.calls[0]?.[0]?.input).toBe("backbone什么意思");
    expect(replyToMessage).toHaveBeenCalledWith("message_backbone", "收到，我来看看。");
  });

  it("recognizes photo-generation phrasing as an image task and uses an image-specific acceptance reply", async () => {
    const submitTask = vi.fn().mockResolvedValue({ taskId: "task_image", taskType: "SIMPLE" });
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask,
      },
      {} as never,
      {},
    );
    const replyToMessage = vi.fn();
    (bot as unknown as { replyToMessage: typeof replyToMessage }).replyToMessage = replyToMessage;

    await (bot as unknown as {
      handleIncomingMessageEvent: (event: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessageEvent({
      message: {
        message_id: "message_photo",
        chat_id: "chat_123",
        content: JSON.stringify({ text: "给我一张噜噜超级可爱的照片" }),
      },
      sender: {
        sender_id: {
          open_id: "open_123",
        },
      },
    });

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(submitTask.mock.calls[0]?.[0]?.requestedIntent).toBe("image");
    expect(submitTask.mock.calls[0]?.[0]?.artifactType).toBe("image");
    expect(replyToMessage).toHaveBeenCalledWith("message_photo", "收到，这就给你出图。");
  });

  it("uses subtype-specific acceptance replies for avatar and edit-image requests", async () => {
    const submitTask = vi.fn().mockResolvedValue({ taskId: "task_image_subtype", taskType: "SIMPLE" });
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask,
      },
      {} as never,
      {},
    );
    const replyToMessage = vi.fn();
    (bot as unknown as { replyToMessage: typeof replyToMessage }).replyToMessage = replyToMessage;

    await (bot as unknown as {
      handleIncomingMessageEvent: (event: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessageEvent({
      message: {
        message_id: "message_avatar",
        chat_id: "chat_123",
        content: JSON.stringify({ text: "帮我做一个微信头像，可爱一点" }),
      },
      sender: {
        sender_id: {
          open_id: "open_123",
        },
      },
    });

    await (bot as unknown as {
      handleIncomingMessageEvent: (event: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessageEvent({
      message: {
        message_id: "message_edit",
        chat_id: "chat_123",
        content: JSON.stringify({ text: "帮我把这张图重绘成宫崎骏风" }),
      },
      sender: {
        sender_id: {
          open_id: "open_123",
        },
      },
    });

    expect(replyToMessage).toHaveBeenNthCalledWith(1, "message_avatar", "收到，这就给你做头像。");
    expect(replyToMessage).toHaveBeenNthCalledWith(2, "message_edit", "收到，我先按你的方向改图。");
  });

  it("treats professional-upgrade followups as a continuation of the latest answered question", async () => {
    const submitTask = vi.fn().mockResolvedValue({ taskId: "task_upgrade", taskType: "COMPLEX" });
    const previousTask = createTaskRecord({
      id: "task_previous_answer",
      type: "SIMPLE",
      status: "completed",
      sourceMeta: {
        chatId: "chat_123",
        messageId: "message_previous",
        workflow: createWorkflowMeta({
          intent: "qa",
          tier: "T1",
        }),
      },
      userInput: "柔性关节机械臂的特点是什么",
      normalizedInput: "柔性关节机械臂的特点是什么",
      summary: "柔性关节机械臂的特点是什么",
      result: {
        answer: "柔性关节机械臂比较灵活，也更安全。",
        provider: "gemini_api",
      },
    });
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask,
      },
      {
        listTasks: vi.fn().mockResolvedValue([{ id: "task_previous_answer" }]),
        getTask: vi.fn(async (taskId: string) => taskId === "task_previous_answer" ? previousTask : null),
      } as never,
      {},
    );
    const replyToMessage = vi.fn();
    (bot as unknown as { replyToMessage: typeof replyToMessage }).replyToMessage = replyToMessage;

    await (bot as unknown as {
      handleIncomingMessageEvent: (event: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessageEvent({
      message: {
        message_id: "message_upgrade",
        chat_id: "chat_123",
        content: JSON.stringify({ text: "我需要更专业的回答" }),
      },
      sender: {
        sender_id: {
          open_id: "open_123",
        },
      },
    });

    expect(submitTask).toHaveBeenCalledTimes(1);
    const submission = submitTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(submission.input ?? "")).toContain("原始问题：柔性关节机械臂的特点是什么");
    expect(String(submission.input ?? "")).toContain("上一版回答：柔性关节机械臂比较灵活，也更安全。");
    expect(String(submission.input ?? "")).toContain("补充要求：我需要更专业的回答");
    expect(String(submission.input ?? "")).toContain("不要要求用户重复描述主题");
    expect(submission.requestedType).toBe("COMPLEX");
    expect(submission.qualityLevel).toBe("high");
    expect((submission.presetHints as Record<string, unknown>)?.preferredReasoning).toBe("pro");
    expect((submission.sourceMeta as Record<string, unknown>)?.continuedFromTaskId).toBe("task_previous_answer");
    expect(((submission.sourceMeta as Record<string, unknown>)?.continuation as Record<string, unknown>)?.fromTaskId).toBe("task_previous_answer");
    expect(replyToMessage).toHaveBeenCalledWith("message_upgrade", "收到，我按更专业的标准重新处理。\n任务 task_upgrade");
  });

  it("treats dissatisfaction followups with added requirements as a continuation of the latest answered question", async () => {
    const submitTask = vi.fn().mockResolvedValue({ taskId: "task_retry", taskType: "COMPLEX" });
    const previousTask = createTaskRecord({
      id: "task_previous_reply",
      type: "SIMPLE",
      status: "completed",
      sourceMeta: {
        chatId: "chat_123",
        messageId: "message_previous",
        workflow: createWorkflowMeta({
          intent: "qa",
          tier: "T1",
        }),
      },
      userInput: "合肥云闪付有奖发票活动，第二期抽奖的发票时间，必须是4月1号及以后日期的吗",
      normalizedInput: "合肥云闪付有奖发票活动，第二期抽奖的发票时间，必须是4月1号及以后日期的吗",
      summary: "合肥云闪付有奖发票活动第二期发票日期要求",
      result: {
        answer: "请查看活动公告或 APP 内说明。",
        provider: "gemini_api",
      },
    });
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask,
      },
      {
        listTasks: vi.fn().mockResolvedValue([{ id: "task_previous_reply" }]),
        getTask: vi.fn(async (taskId: string) => taskId === "task_previous_reply" ? previousTask : null),
      } as never,
      {},
    );
    const replyToMessage = vi.fn();
    (bot as unknown as { replyToMessage: typeof replyToMessage }).replyToMessage = replyToMessage;

    await (bot as unknown as {
      handleIncomingMessageEvent: (event: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessageEvent({
      message: {
        message_id: "message_retry",
        chat_id: "chat_123",
        content: JSON.stringify({ text: "不满意这个回复，我需要查到具体规则" }),
      },
      sender: {
        sender_id: {
          open_id: "open_123",
        },
      },
    });

    expect(submitTask).toHaveBeenCalledTimes(1);
    const submission = submitTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(submission.input ?? "")).toContain("原始问题：合肥云闪付有奖发票活动，第二期抽奖的发票时间，必须是4月1号及以后日期的吗");
    expect(String(submission.input ?? "")).toContain("上一版回答：请查看活动公告或 APP 内说明。");
    expect(String(submission.input ?? "")).toContain("补充要求：不满意这个回复，我需要查到具体规则");
    expect((submission.sourceMeta as Record<string, unknown>)?.continuedFromTaskId).toBe("task_previous_reply");
    expect(replyToMessage).toHaveBeenCalledWith("message_retry", "收到，我按更专业的标准重新处理。\n任务 task_retry");
  });

  it("uses a realtime-specific acceptance reply for current-rule questions", async () => {
    const submitTask = vi.fn().mockResolvedValue({ taskId: "task_realtime", taskType: "SIMPLE" });
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask,
      },
      {} as never,
      {},
    );
    const replyToMessage = vi.fn();
    (bot as unknown as { replyToMessage: typeof replyToMessage }).replyToMessage = replyToMessage;

    await (bot as unknown as {
      handleIncomingMessageEvent: (event: Record<string, unknown>) => Promise<void>;
    }).handleIncomingMessageEvent({
      message: {
        message_id: "message_realtime",
        chat_id: "chat_123",
        content: JSON.stringify({ text: "合肥云闪付有奖发票活动，第二期抽奖的发票时间，必须是4月1号及以后日期的吗" }),
      },
      sender: {
        sender_id: {
          open_id: "open_123",
        },
      },
    });

    expect(replyToMessage).toHaveBeenCalledWith("message_realtime", "我先查一下最新规则。");
  });

  it("filters prompt leakage from simple Feishu answers", async () => {
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask: vi.fn(),
      },
      {} as never,
      {},
    );
    const sendTextToChat = vi.fn();
    const sendCardToChat = vi.fn();
    (bot as unknown as { sendTextToChat: typeof sendTextToChat }).sendTextToChat = sendTextToChat;
    (bot as unknown as { sendCardToChat: typeof sendCardToChat }).sendCardToChat = sendCardToChat;

    await bot.replyTaskResult(createTaskRecord({
      sourceMeta: {
        chatId: "chat_123",
        workflow: {
          intent: "qa",
        },
      },
      result: {
        answer: [
          "用户问题：不要",
          "最近相关记忆：layered_memory task_history",
          "backbone 通常指“骨干、主干、支柱”，在技术语境里也常指主干网络。",
        ].join("\n"),
        provider: "doubao_web",
      },
    }));

    // Simple QA now sends plain text instead of card
    const textMsg = sendTextToChat.mock.calls[0]?.[1] as string;
    expect(textMsg).toContain("backbone 通常指“骨干、主干、支柱”");
    expect(textMsg).not.toContain("用户问题：不要");
    expect(textMsg).not.toContain("layered_memory");

    expect(sendCardToChat).not.toHaveBeenCalled();
  });

  it("keeps detailed execution trace for complex multi-model tasks in the collapsible panel", async () => {
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask: vi.fn(),
      },
      {} as never,
      {},
    );
    const sendCardToChat = vi.fn();
    (bot as unknown as { sendCardToChat: typeof sendCardToChat }).sendCardToChat = sendCardToChat;

    await bot.replyTaskResult(createTaskRecord({
      type: "CODING",
      sourceMeta: {
        chatId: "chat_123",
        workflow: createWorkflowMeta({
          intent: "coding",
          tier: "T3",
          qualityLevel: "high",
          complexity: "hard",
          modelPlan: {
            drafter: { role: "zhongshu_drafter", provider: "gemini_api", preset: "standard", timeoutMs: 30_000 },
            reviewers: [
              { role: "hanlin_reviewer", provider: "claude_web", preset: "expert", timeoutMs: 90_000 },
              { role: "hanlin_reviewer", provider: "grok_web", preset: "pro", timeoutMs: 90_000 },
            ],
            arbiter: { role: "zhongshu_arbiter", provider: "chatgpt_web", preset: "pro", timeoutMs: 120_000 },
          },
        }),
      },
      result: {
        answer: "最终建议先统一 provider fallback，再补重试和链路展示。",
        provider: "chatgpt_web",
        providerMeta: {
          model: "gpt-5.4",
        },
        draftOutput: {
          provider: "gemini_api",
          text: "先排查 429、模型命中和回退链路，再确认是否需要改调度。",
        },
        reviewOutputs: [
          {
            provider: "claude_web",
            text: "建议优先补链路可视化，不然用户会误判成没有走到 Gemini。",
          },
          {
            provider: "grok_web",
            text: "建议把 CLI 和 API 的默认模型统一到免费层更稳的 flash-lite。",
          },
        ],
        candidatePlans: [
          {
            provider: "gemini_api",
            plan: "先打通 gemini_api，再处理回退策略。",
          },
          {
            provider: "claude_web",
            plan: "先补链路展示和错误诊断，再收敛默认模型。",
          },
        ],
        finalPlan: "最终决定：默认用 2.5-flash-lite，复杂任务升级到 2.5-flash，并保留链路与过程折叠卡。",
        codexExecution: {
          stdout: "Updated providers and Feishu formatting.",
          stderr: "",
        },
        audit: {
          decision: "pass",
          rawText: "审核通过；链路说明完整，可执行性明确。",
        },
      },
      steps: [
        {
          id: "step_1",
          taskId: "task_regression",
          phase: "drafting",
          provider: "gemini_api",
          status: "completed",
          meta: { preset: "standard" },
          startedAt: new Date("2026-03-31T06:00:00.000Z"),
          endedAt: new Date("2026-03-31T06:00:05.000Z"),
        },
        {
          id: "step_2",
          taskId: "task_regression",
          phase: "reviewing",
          provider: "claude_web",
          status: "completed",
          meta: { preset: "expert" },
          startedAt: new Date("2026-03-31T06:00:06.000Z"),
          endedAt: new Date("2026-03-31T06:00:12.000Z"),
        },
      ],
    }));

    const card = sendCardToChat.mock.calls[0]?.[1] as Record<string, unknown>;
    const elements = Array.isArray(card?.elements) ? (card.elements as Array<Record<string, unknown>>) : [];
    const panel = elements.find((element) => element.tag === "collapsible_panel") as Record<string, unknown> | undefined;
    const panelElements = Array.isArray(panel?.elements) ? (panel?.elements as Array<Record<string, unknown>>) : [];
    const merged = panelElements.map((element) => String(element.content ?? "")).join("\n");

    expect(panel?.tag).toBe("collapsible_panel");
    expect(merged).toContain("链路规划");
    expect(merged).toContain("实际执行");
    expect(merged).toContain("草稿过程 · gemini_api");
    expect(merged).toContain("复审过程 · claude_web");
    expect(merged).toContain("方案讨论 · gemini_api");
    expect(merged).toContain("实施记录");
    expect(merged).toContain("审核过程 · 审核通过");
  });

  it("prefers issue summary instead of false repair claims when no concrete code changes are detected", async () => {
    const bot = new FeishuBotApp(
      {
        defaultChatId: "chat_123",
      },
      {
        submitTask: vi.fn(),
      },
      {} as never,
      {},
    );
    const sendCardToChat = vi.fn();
    (bot as unknown as { sendCardToChat: typeof sendCardToChat }).sendCardToChat = sendCardToChat;

    await bot.replyTaskResult(createTaskRecord({
      type: "CODING",
      sourceMeta: {
        chatId: "chat_123",
        workflow: {
          intent: "coding",
        },
      },
      userInput: "先给我展示问题是什么，不要直接说修好了",
      summary: "先给我展示问题是什么，不要直接说修好了",
      result: {
        answer: "根因是天气预警去重 key 不稳定，同一事件窗口里会重复命中。",
        provider: "codex_runner",
      },
    }));

    const card = sendCardToChat.mock.calls[0]?.[1] as Record<string, unknown>;
    const elements = Array.isArray(card?.elements) ? (card.elements as Array<Record<string, unknown>>) : [];
    const text = String((elements[0] as Record<string, unknown>)?.content ?? "");
    expect(text).toContain("问题：根因是天气预警去重 key 不稳定");
    expect(text).not.toContain("代码已经实际修改");
    expect(text).not.toContain("问题已修复");
  });

  it("treats Codex runs as authorization-pending even when warnings only appear in stderr", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "iai-direct-codex-stderr-"));
    await mkdir(taskDir, { recursive: true });

    let task: TaskRecord = {
      id: "task_direct_codex_stderr_warning",
      type: "CODING",
      status: "queued",
      source: "feishu",
      sourceMeta: {
        chatId: "chat_123",
        routeOverrides: {
          autoRunCodex: true,
          directToCodex: true,
          directCliRunner: "codex",
        },
      },
      userInput: "请用 codex 修复这个 bug 并直接改代码",
      normalizedInput: "请用 codex 修复这个 bug 并直接改代码",
      summary: "请用 codex 修复这个 bug 并直接改代码",
      outputSummary: null,
      result: null,
      error: null,
      cacheKey: "cache",
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      steps: [],
    };

    const store = {
      updateTask: vi.fn(async (_taskId: string, patch: Partial<TaskRecord>) => {
        task = {
          ...task,
          ...patch,
          updatedAt: new Date(),
        };
        return task;
      }),
      getTask: vi.fn(async () => task),
      findPendingApprovalRequestByTask: vi.fn(async () => null),
      createApprovalRequest: vi.fn(async (input: Record<string, unknown>) => ({
        id: "approval_2",
        taskId: task.id,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...input,
      })),
      completeTask: vi.fn(async () => {
        throw new Error("completeTask should not be called when Codex reports a permission-limited write in stdout");
      }),
      failTask: vi.fn(async () => {
        throw new Error("failTask should not be called when Codex needs authorization");
      }),
    };

    const orchestrator = new TaskOrchestrator(
      store as never,
      { list: () => [] } as never,
      {} as never,
      {} as never,
      {
        notifyTaskAccepted: vi.fn(),
        notifyTaskCompleted: vi.fn(),
        notifyTaskFailed: vi.fn(),
        notifyProviderAttention: vi.fn(),
      } as never,
      {
        isAvailable: vi.fn(async () => true),
        createArtifacts: vi.fn(async (): Promise<CodingArtifacts> => ({
          taskDir,
          implementationBriefPath: join(taskDir, "implementation_brief.md"),
          implementationPlanPath: join(taskDir, "implementation_plan.json"),
          acceptanceChecklistPath: join(taskDir, "acceptance_checklist.md"),
          contextSummaryPath: join(taskDir, "context_summary.md"),
          codexTaskPath: join(taskDir, "codex_task.md"),
        })),
        run: vi.fn(async () => ({
          stdout: "apply_patch 被策略拒绝，仓库仍是 read-only，没法真正写入文件。",
          stderr: "WARN state db discrepancy",
          success: true,
          sessionId: "session_456",
        })),
      } as never,
      {} as never,
      [],
    );

    const workflow: WorkflowMeta = {
      tier: "T2",
      intent: "coding",
      budget: "standard",
      artifactType: "none",
      qualityLevel: "standard",
      riskLevel: "low",
      complexity: "easy",
      complexityScore: 0.2,
      audit: {
        requested: false,
        required: false,
        triggers: [],
        strategy: "structured_gate",
        maxRevisionRounds: 1,
      },
      selectedSkills: [],
    };

    const result = await (orchestrator as unknown as {
      executeDirectCodexHandoff: (
        task: TaskRecord,
        workflow: WorkflowMeta,
        route: { autoRunCodex: boolean },
        localContext: { summary: string; backend: string } | null,
      ) => Promise<TaskRecord>;
    }).executeDirectCodexHandoff(task, workflow, { autoRunCodex: true }, null);

    expect(result.status).toBe("needs_human_intervention");
    expect((result.result as Record<string, unknown>).authorizationPending).toBe(true);
    expect(String(result.error ?? "")).toContain("尚未真正写入文件");

    await rm(taskDir, { recursive: true, force: true });
  });

  it("does not push mock bulletin content as a real scheduler report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T00:00:20.000Z"));
    stubGitHubTrendingFetch();

    const stateDir = await mkdtemp(join(tmpdir(), "iai-hot-topic-mock-"));
    const stateFile = join(stateDir, "scheduler-state.json");
    const pushTextToChat = vi.fn();
    const completedTask = {
      id: "task_hot_topic_mock",
      type: "SIMPLE",
      status: "completed",
      source: "scheduler",
      sourceMeta: {
        schedulerKind: "daily_hot_topics",
        scheduledAt: "2026-03-30 08:00",
      },
      result: {
        provider: "mock_provider",
        answer: "这是来自 mock_provider 的演示回复。当前主链路可用，但这次没有命中真实网页模型，所以返回了本地 mock 结果。",
      },
      outputSummary: "这是来自 mock_provider 的演示回复。当前主链路可用，但这次没有命中真实网页模型，所以返回了本地 mock 结果。",
    };

    const scheduler = new PushScheduler(
      {
        scheduler: {
          enabled: true,
          stateFile,
          hotTopics: {
            enabled: true,
            times: ["08:00"],
          },
          weather: {
            enabled: false,
          },
          gold: {
            enabled: false,
          },
        },
        feishu: {
          defaultChatId: "chat_123",
        },
      } as never,
      {
        submitTask: vi.fn(async () => ({
          taskId: "task_hot_topic_mock",
          taskType: "SIMPLE",
        })),
      } as never,
      {
        listTasks: vi.fn().mockResolvedValue([]),
        getTask: vi.fn(async (taskId: string) => taskId === "task_hot_topic_mock" ? completedTask as never : null),
      } as never,
      {
        pushTextToChat,
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    );

    await (scheduler as unknown as { tickHotTopics: () => Promise<void> }).tickHotTopics();

    expect(pushTextToChat).toHaveBeenCalledTimes(1);
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).toContain("生成失败：真实网页模型当前不可用");
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).toContain("GitHub 热门项目：acme/frontier-agent");
    expect(String(pushTextToChat.mock.calls[0]?.[1] ?? "")).not.toContain("这是来自 mock_provider 的演示回复");

    await rm(stateDir, { recursive: true, force: true });
  });
});
