import { randomUUID } from "node:crypto";
import type {
  AgentHeartbeat,
  AgentRole,
  AuditDecision,
  MonitorDashboardReport,
  MonitorEvent,
  MonitorEventType,
  ProviderMonitorReport,
  TaskMonitorReport,
  TaskRecord,
  WorkflowMeta,
} from "./types";

export class MonitorHub {
  private readonly events: MonitorEvent[] = [];
  private readonly taskReports = new Map<string, TaskMonitorReport>();
  private readonly heartbeats = new Map<string, AgentHeartbeat>();
  private readonly providers = new Map<string, ProviderMonitorReport>();
  private readonly listeners = new Set<(event: MonitorEvent, snapshot: MonitorDashboardReport) => void>();

  emit(input: Omit<MonitorEvent, "id" | "timestamp">): MonitorEvent {
    const event: MonitorEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };

    this.events.unshift(event);
    if (this.events.length > 300) {
      this.events.length = 300;
    }

    if (event.taskId) {
      const existing = this.taskReports.get(event.taskId);
      if (existing) {
        this.taskReports.set(event.taskId, {
          ...existing,
          status: event.status ?? existing.status,
          updatedAt: event.timestamp,
          lastProvider: event.provider ?? existing.lastProvider,
          audit:
            event.type.startsWith("audit.")
              ? {
                  required: existing.audit?.required ?? false,
                  triggers: existing.audit?.triggers ?? [],
                  lastDecision: inferDecision(event.type),
                  revisionRound: existing.audit?.revisionRound,
                }
              : existing.audit,
        });
      }
    }

    if (event.provider) {
      const current = this.providers.get(event.provider) ?? {
        provider: event.provider,
        totalCalls: 0,
        failures: 0,
        lastStatus: "idle",
      };

      const next: ProviderMonitorReport = {
        ...current,
        totalCalls: current.totalCalls + (event.type === "provider.started" ? 1 : 0),
        failures: current.failures + (event.type === "provider.failed" ? 1 : 0),
        lastStatus: inferProviderStatus(event.type),
        lastSeenAt: event.timestamp,
      };
      this.providers.set(event.provider, next);
    }

    const snapshot = this.getSnapshot(20);
    for (const listener of this.listeners) {
      listener(event, snapshot);
    }

    return event;
  }

  recordTask(task: TaskRecord, workflow?: WorkflowMeta): void {
    const current = this.taskReports.get(task.id);
    this.taskReports.set(task.id, {
      taskId: task.id,
      type: task.type,
      status: task.status,
      summary: task.summary ?? null,
      updatedAt: task.updatedAt.toISOString(),
      rolePlan: workflow?.rolePlan ?? current?.rolePlan,
      workflow: workflow ?? current?.workflow,
      lastProvider: current?.lastProvider,
      audit:
        workflow?.audit || current?.audit
          ? {
              required: workflow?.audit.required ?? current?.audit?.required ?? false,
              triggers: workflow?.audit.triggers ?? current?.audit?.triggers ?? [],
              lastDecision: current?.audit?.lastDecision,
              revisionRound: current?.audit?.revisionRound,
            }
          : undefined,
    });
  }

  heartbeat(role: AgentRole, input?: { provider?: string; state?: AgentHeartbeat["state"]; detail?: string }): void {
    const key = input?.provider ? `${role}:${input.provider}` : role;
    this.heartbeats.set(key, {
      role,
      provider: input?.provider,
      state: input?.state ?? "idle",
      detail: input?.detail,
      seenAt: new Date().toISOString(),
    });
  }

  incrementAuditRound(taskId: string): void {
    const current = this.taskReports.get(taskId);
    if (!current?.audit) {
      return;
    }

    this.taskReports.set(taskId, {
      ...current,
      audit: {
        ...current.audit,
        revisionRound: (current.audit.revisionRound ?? 0) + 1,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  getSnapshot(limit = 40): MonitorDashboardReport {
    return {
      generatedAt: new Date().toISOString(),
      activeTasks: [...this.taskReports.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit),
      heartbeats: [...this.heartbeats.values()].sort((left, right) => right.seenAt.localeCompare(left.seenAt)),
      providers: [...this.providers.values()].sort((left, right) => left.provider.localeCompare(right.provider)),
      recentEvents: this.listEvents(limit),
    };
  }

  listEvents(limit = 100, type?: MonitorEventType): MonitorEvent[] {
    return this.events.filter((event) => !type || event.type === type).slice(0, limit);
  }

  subscribe(listener: (event: MonitorEvent, snapshot: MonitorDashboardReport) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  buildFeishuDigest(limit = 5): { header: string; lines: string[] } {
    const snapshot = this.getSnapshot(limit);
    const lines = [
      `活跃任务: ${snapshot.activeTasks.length}`,
      `Provider 数: ${snapshot.providers.length}`,
      ...snapshot.activeTasks.slice(0, limit).map((task) => `${task.taskId} · ${task.status} · ${task.summary ?? "-"}`),
    ];

    return {
      header: "智能体监控看板",
      lines,
    };
  }
}

function inferDecision(type: MonitorEventType): AuditDecision | undefined {
  if (type === "audit.passed") {
    return "pass";
  }
  if (type === "audit.revise_required") {
    return "revise_required";
  }
  if (type === "audit.rejected") {
    return "reject";
  }
  return undefined;
}

function inferProviderStatus(type: MonitorEventType): ProviderMonitorReport["lastStatus"] {
  if (type === "provider.started") {
    return "running";
  }
  if (type === "provider.completed") {
    return "success";
  }
  if (type === "provider.failed") {
    return "failed";
  }
  return "idle";
}
