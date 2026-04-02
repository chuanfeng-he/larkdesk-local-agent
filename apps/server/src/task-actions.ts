import { summarizeText } from "@office-agent/core";
import type { CodexRunner, MonitorHub, TaskNotifier, TaskRecord, TaskStore } from "@office-agent/core";

export interface TaskActionController {
  stopTask(taskId: string): Promise<TaskRecord | null>;
  interveneTask(taskId: string): Promise<TaskRecord | null>;
  approveTask(taskId: string): Promise<TaskRecord | null>;
  rejectTask(taskId: string, note?: string): Promise<TaskRecord | null>;
}

export function createTaskActionController(input: {
  store: TaskStore;
  monitor: MonitorHub;
  codexRunner: CodexRunner;
  notifier: TaskNotifier;
  prisma: {
    taskStep: {
      updateMany(args: Record<string, unknown>): Promise<unknown>;
    };
  };
}): TaskActionController {
  const { store, monitor, prisma, codexRunner, notifier } = input;
  const finalStatuses = new Set(["completed", "failed", "needs_browser_launch", "provider_session_lost", "needs_manual_login", "needs_human_intervention"]);

  async function apply(taskId: string, action: "stop" | "intervene"): Promise<TaskRecord | null> {
    const current = await store.getTask(taskId);
    if (!current) {
      return null;
    }

    if (finalStatuses.has(current.status)) {
      return current;
    }

    const now = new Date();
    await prisma.taskStep.updateMany({
      where: {
        taskId,
        status: "started",
      },
      data: {
        status: "failed",
        endedAt: now,
        outputSummary: action === "stop" ? "任务已由人工停止。" : "任务已转人工介入。",
      },
    });

    const task = await store.updateTask(taskId, {
      status: action === "stop" ? "failed" : "needs_human_intervention",
      error: action === "stop" ? "任务已由人工停止，建议重新发起。" : "任务已转人工介入，请人工接管后处理。",
      completedAt: now,
    });

    const workflow = ((task.sourceMeta ?? {}) as Record<string, unknown>).workflow;
    monitor.recordTask(task, workflow && typeof workflow === "object" ? (workflow as any) : undefined);
    monitor.emit({
      type: action === "stop" ? "task.failed" : "task.status_changed",
      taskId: task.id,
      status: task.status,
      detail: action === "stop" ? "任务已由人工停止。" : "任务已转人工介入。",
    });

    return task;
  }

  return {
    stopTask(taskId: string) {
      return apply(taskId, "stop");
    },
    interveneTask(taskId: string) {
      return apply(taskId, "intervene");
    },
    async approveTask(taskId: string) {
      const current = await store.getTask(taskId);
      if (!current) {
        return null;
      }

      const result = (current.result ?? {}) as Record<string, unknown>;
      const sessionId = typeof result.authorizationSessionId === "string" ? result.authorizationSessionId : undefined;
      const resumePrompt = typeof result.authorizationResumePrompt === "string" ? result.authorizationResumePrompt : undefined;
      const authorizationPending = result.authorizationPending === true;
      if (!authorizationPending || !sessionId || !resumePrompt || !codexRunner.resume) {
        return current;
      }

      const pendingApproval = await store.findPendingApprovalRequestByTask(taskId).catch(() => null);
      if (pendingApproval) {
        await store.resolveApprovalRequest({
          id: pendingApproval.id,
          status: "approved",
          decisionNote: "Approved from task action controller.",
        }).catch(() => null);
      }

      const workflow = ((current.sourceMeta ?? {}) as Record<string, unknown>).workflow;
      const resumedTask = await store.updateTask(taskId, {
        status: "implementing",
        error: null,
        completedAt: null,
        result: {
          ...result,
          authorizationPending: false,
          authorizationApprovedAt: new Date().toISOString(),
        },
      });
      monitor.recordTask(resumedTask, workflow && typeof workflow === "object" ? (workflow as any) : undefined);
      monitor.emit({
        type: "task.status_changed",
        taskId: resumedTask.id,
        status: resumedTask.status,
        detail: "已批准 Codex 继续执行。",
      });

      void codexRunner.resume({ sessionId, prompt: resumePrompt }).then(async (execution) => {
        const latest = await store.getTask(taskId);
        if (!latest) {
          return;
        }

        const latestResult = (latest.result ?? {}) as Record<string, unknown>;
        const authMessage = detectAuthorizationNeed(execution.stderr || execution.stdout);
        if (authMessage && execution.sessionId) {
          const pendingTask = await store.updateTask(taskId, {
            status: "needs_human_intervention",
            error: authMessage,
            result: {
              ...latestResult,
              codexExecution: execution,
              authorizationPending: true,
              authorizationRunner: "codex",
              authorizationSessionId: execution.sessionId,
              authorizationResumePrompt: resumePrompt,
              answer: authMessage,
              provider: "codex_runner",
            },
          });
          const latestApproval = await store.findPendingApprovalRequestByTask(taskId).catch(() => null);
          if (!latestApproval) {
            await store.createApprovalRequest({
              taskId,
              policyKey: "cli_authorization",
              kind: "cli_authorization",
              summary: summarizeText(authMessage, 140),
              detail: authMessage,
              runner: "codex",
              source: latest.source,
            }).catch(() => null);
          }
          monitor.recordTask(pendingTask, workflow && typeof workflow === "object" ? (workflow as any) : undefined);
          monitor.emit({
            type: "task.failed",
            taskId: pendingTask.id,
            status: pendingTask.status,
            detail: authMessage,
            provider: "codex_runner",
          });
          await notifier.notifyTaskFailed(pendingTask);
          return;
        }

        if (!execution.success) {
          const latestApproval = await store.findPendingApprovalRequestByTask(taskId).catch(() => null);
          if (latestApproval) {
            await store.resolveApprovalRequest({
              id: latestApproval.id,
              status: "resolved",
              decisionNote: "Resume execution ended without success.",
            }).catch(() => null);
          }
          const failed = await store.updateTask(taskId, {
            status: "failed",
            error: summarizeText(execution.stderr || execution.stdout || "Codex resume failed.", 240),
            completedAt: new Date(),
            result: {
              ...latestResult,
              codexExecution: execution,
              answer: summarizeText(execution.stderr || execution.stdout || "Codex resume failed.", 240),
              provider: "codex_runner",
            },
          });
          monitor.recordTask(failed, workflow && typeof workflow === "object" ? (workflow as any) : undefined);
          monitor.emit({
            type: "task.failed",
            taskId: failed.id,
            status: failed.status,
            detail: failed.error ?? "Codex resume failed.",
            provider: "codex_runner",
          });
          await notifier.notifyTaskFailed(failed);
          return;
        }

        const summary = summarizeText(execution.stdout || "Codex 已继续执行完成。", 240);
        const latestApproval = await store.findPendingApprovalRequestByTask(taskId).catch(() => null);
        if (latestApproval) {
          await store.resolveApprovalRequest({
            id: latestApproval.id,
            status: "resolved",
            decisionNote: "Execution completed after approval.",
          }).catch(() => null);
        }
        const completed = await store.completeTask(taskId, summary, {
          ...latestResult,
          codexExecution: execution,
          authorizationPending: false,
          answer: execution.stdout || summary,
          provider: "codex_runner",
        });
        monitor.recordTask(completed, workflow && typeof workflow === "object" ? (workflow as any) : undefined);
        monitor.emit({
          type: "task.completed",
          taskId: completed.id,
          status: completed.status,
          detail: completed.outputSummary ?? summary,
          provider: "codex_runner",
        });
        await notifier.notifyTaskCompleted(completed);
      }).catch(async (error: unknown) => {
        const failed = await store.updateTask(taskId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        });
        monitor.recordTask(failed, workflow && typeof workflow === "object" ? (workflow as any) : undefined);
        monitor.emit({
          type: "task.failed",
          taskId: failed.id,
          status: failed.status,
          detail: failed.error ?? "Codex resume failed.",
          provider: "codex_runner",
        });
        await notifier.notifyTaskFailed(failed);
      });

      return resumedTask;
    },
    async rejectTask(taskId: string, note?: string) {
      const current = await store.getTask(taskId);
      if (!current) {
        return null;
      }

      const pendingApproval = await store.findPendingApprovalRequestByTask(taskId).catch(() => null);
      if (pendingApproval) {
        await store.resolveApprovalRequest({
          id: pendingApproval.id,
          status: "rejected",
          decisionNote: note ?? "Rejected from task action controller.",
        }).catch(() => null);
      }

      if (finalStatuses.has(current.status)) {
        return current;
      }

      const rejected = await store.updateTask(taskId, {
        status: "failed",
        error: note ? `授权已拒绝：${note}` : "授权已拒绝，任务已停止。",
        completedAt: new Date(),
        result: {
          ...((current.result ?? {}) as Record<string, unknown>),
          authorizationPending: false,
          authorizationRejectedAt: new Date().toISOString(),
          authorizationRejectedNote: note ?? null,
        },
      });

      const workflow = ((rejected.sourceMeta ?? {}) as Record<string, unknown>).workflow;
      monitor.recordTask(rejected, workflow && typeof workflow === "object" ? (workflow as any) : undefined);
      monitor.emit({
        type: "task.failed",
        taskId: rejected.id,
        status: rejected.status,
        detail: rejected.error ?? "任务授权已拒绝。",
      });
      await notifier.notifyTaskFailed(rejected);
      return rejected;
    },
  };
}

function detectAuthorizationNeed(raw: string): string | null {
  const normalized = raw.toLowerCase();
  const markers = [
    "权限",
    "permission denied",
    "operation not permitted",
    "requires permission",
    "approval",
    "sandbox",
    "access denied",
  ];

  if (!markers.some((marker) => normalized.includes(marker))) {
    return null;
  }

  return `Codex 还需要一次授权才能继续：${summarizeText(raw, 220)}`;
}
