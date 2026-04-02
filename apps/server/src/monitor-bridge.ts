import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { FeishuBotApp, FeishuNotifier } from "@office-agent/feishu";
import type { MonitorDashboardReport, MonitorEvent, MonitorHub, TaskMonitorReport, TaskRecord, TaskStore } from "@office-agent/core";

const IMPORTANT_EVENT_TYPES = new Set<MonitorEvent["type"]>([
  "task.failed",
  "provider.failed",
  "audit.required",
  "audit.rejected",
  "config.reload_failed",
]);

function toWebSocketAccept(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "utf8")
    .digest("base64");
}

function encodeTextFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }

  if (body.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function safeWrite(socket: Socket, payload: string): void {
  if (socket.destroyed) {
    return;
  }
  socket.write(encodeTextFrame(payload));
}

export class MonitorDiagnosticsBridge {
  private readonly throttles = new Map<string, number>();
  private readonly sockets = new Set<Socket>();
  private unsubscribe: (() => void) | null = null;
  private attached = false;

  constructor(
    private readonly server: HttpServer,
    private readonly monitor: MonitorHub,
    private readonly feishuNotifier?: FeishuNotifier | null,
    taskStore?: TaskStore | null,
    feishuBot?: FeishuBotApp | null,
  ) {
    void taskStore;
    void feishuBot;
  }

  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    this.server.on("upgrade", this.handleUpgrade);
    this.unsubscribe = this.monitor.subscribe((event, snapshot) => {
      this.broadcast({ type: "event", event, snapshot });
      void this.pushDiagnosticCard(event, snapshot);
    });
  }

  close(): void {
    this.server.off("upgrade", this.handleUpgrade);
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
  }

  private readonly handleUpgrade = (request: IncomingMessage, socket: Socket): void => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/monitor/ws") {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = toWebSocketAccept(key);
    const response = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n");
    socket.write(response);
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
    socket.on("end", () => {
      this.sockets.delete(socket);
    });
    socket.on("error", () => {
      this.sockets.delete(socket);
    });
    socket.on("data", () => {
      // This dashboard is server-push only; ignore client frames.
    });

    safeWrite(
      socket,
      JSON.stringify({
        type: "snapshot",
        snapshot: this.monitor.getSnapshot(20),
      }),
    );
  };

  private broadcast(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    for (const socket of this.sockets) {
      safeWrite(socket, body);
    }
  }

  private async pushDiagnosticCard(event: MonitorEvent, snapshot: MonitorDashboardReport): Promise<void> {
    if (!this.feishuNotifier || !IMPORTANT_EVENT_TYPES.has(event.type)) {
      return;
    }

    const key = `${event.type}:${event.provider ?? "-"}:${event.taskId ?? "-"}`;
    const now = Date.now();
    const last = this.throttles.get(key) ?? 0;
    if (now - last < 15_000) {
      return;
    }
    this.throttles.set(key, now);

    const activeTasks = snapshot.activeTasks.slice(0, 3).map((task) => `${task.taskId} · ${task.status} · ${task.summary ?? "-"}`);
    await this.feishuNotifier.pushCard({
      header: `诊断告警 · ${getEventLabel(event.type)}`,
      lines: [
        `任务: ${event.taskId ?? "-"}`,
        `节点: ${event.provider ?? "-"}`,
        `详情: ${event.detail ?? "-"}`,
        `活跃任务数: ${snapshot.activeTasks.length}`,
        ...activeTasks.map((line) => line.replace(/ · /g, " · ")),
      ],
    });
  }
}

function getStatusLabel(status: string | undefined): string {
  const labels: Record<string, string> = {
    queued: "已排队",
    classifying: "任务识别中",
    routing: "链路规划中",
    skill_planning: "技能装配中",
    drafting: "草稿生成中",
    reviewing: "复审中",
    audit_pending: "审核中",
    audit_revising: "修订中",
    arbitrating: "仲裁定稿中",
    handoff_to_codex: "交接实现中",
    implementing: "实施中",
    testing: "测试中",
    completed: "已完成",
    failed: "已失败",
    needs_browser_launch: "等待模型窗口启动",
    provider_session_lost: "模型会话失联",
    needs_manual_login: "等待人工登录",
    needs_human_intervention: "等待人工介入",
  };
  return labels[status ?? ""] ?? (status ?? "-");
}

function getRoleLabel(role: string | undefined): string {
  const labels: Record<string, string> = {
    crown_orchestrator: "舰长",
    zhongshu_drafter: "首席科学官",
    hanlin_reviewer: "大副",
    menxia_auditor: "安全官",
    zhongshu_arbiter: "通讯官",
    shangshu_executor: "轮机长",
    junji_implementer: "导航员",
    sitian_monitor: "瞭望塔",
  };
  return labels[role ?? ""] ?? (role ?? "-");
}

function getRoleDescription(role: string | undefined): string {
  const descriptions: Record<string, string> = {
    crown_orchestrator: "负责统筹任务、选路由、安排各角色分工。",
    zhongshu_drafter: "负责先起草第一版答案或方案。",
    hanlin_reviewer: "负责复审草稿，挑问题、补细节、提修正建议。",
    menxia_auditor: "负责做最终审核把关，决定通过、修订或驳回。",
    zhongshu_arbiter: "负责综合草稿和复审意见，整理成最终版本。",
    shangshu_executor: "负责把最终内容落成文档、PPT、图片等产物。",
    junji_implementer: "负责具体实现、落地执行和测试。",
    sitian_monitor: "负责监控全流程状态、异常和进度播报。",
  };
  return descriptions[role ?? ""] ?? "负责该环节执行。";
}

function getEventLabel(type: MonitorEvent["type"]): string {
  const labels: Record<MonitorEvent["type"], string> = {
    "task.accepted": "任务已接收",
    "task.status_changed": "任务状态变更",
    "task.completed": "任务完成",
    "task.failed": "任务失败",
    "task.cache_hit": "命中缓存",
    "task.route_selected": "链路已选定",
    "task.skills_selected": "技能已装配",
    "provider.started": "节点开始执行",
    "provider.completed": "节点执行完成",
    "provider.failed": "节点执行失败",
    "audit.required": "进入审核",
    "audit.passed": "审核通过",
    "audit.revise_required": "要求修订",
    "audit.rejected": "审核驳回",
    "role.heartbeat": "角色心跳",
    "config.reloaded": "配置已重载",
    "config.reload_failed": "配置重载失败",
  };
  return labels[type];
}

function getProgress(status: string | undefined): number {
  const mapping: Record<string, number> = {
    queued: 5,
    classifying: 12,
    routing: 20,
    skill_planning: 28,
    drafting: 42,
    reviewing: 58,
    audit_pending: 74,
    audit_revising: 82,
    arbitrating: 88,
    handoff_to_codex: 90,
    implementing: 94,
    testing: 97,
    completed: 100,
    failed: 100,
    needs_browser_launch: 100,
    provider_session_lost: 100,
    needs_manual_login: 100,
    needs_human_intervention: 100,
  };
  return mapping[status ?? ""] ?? 0;
}

function buildRoleSummary(task: TaskMonitorReport): string[] {
  const chain = task.rolePlan?.chain ?? [];
  if (chain.length === 0) {
    return [];
  }

  const currentRole =
    task.status === "reviewing"
      ? "hanlin_reviewer"
      : task.status === "audit_pending" || task.status === "audit_revising"
        ? "menxia_auditor"
        : task.status === "arbitrating"
          ? "zhongshu_arbiter"
          : task.status === "handoff_to_codex" || task.status === "implementing" || task.status === "testing"
            ? "junji_implementer"
            : task.status === "completed"
              ? null
              : "zhongshu_drafter";
  const currentIndex = currentRole ? chain.findIndex((item) => item.role === currentRole) : -1;

  return chain.slice(0, 6).map((item, index) => {
    let state = "待执行";
    if (task.status === "completed") {
      state = "已完成";
    } else if (task.status === "failed" || task.status === "needs_browser_launch" || task.status === "provider_session_lost" || task.status === "needs_manual_login" || task.status === "needs_human_intervention") {
      if (currentIndex >= 0 && index < currentIndex) state = "已完成";
      else if (currentIndex >= 0 && index === currentIndex) state = "已受阻";
    } else if (currentIndex >= 0) {
      if (index < currentIndex) state = "已完成";
      else if (index === currentIndex) state = "进行中";
    }

    return `${state} ${item.title ?? getRoleLabel(item.role)}${item.provider ? ` · ${item.provider}` : ""}`;
  });
}

export function buildMonitorDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IAI 任务看板</title>
    <style>
      :root {
        --bg: #f2efe8;
        --panel: rgba(255,255,255,0.92);
        --line: #d8d1c5;
        --ink: #172126;
        --muted: #607076;
        --accent: #145c59;
        --accent-soft: rgba(20,92,89,0.12);
        --good: #1e7b57;
        --warn: #b96a19;
        --bad: #c64545;
      }
      body {
        margin: 0;
        font-family: "Noto Serif SC", "Source Han Serif SC", "PingFang SC", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(20,92,89,0.14), transparent 28%),
          radial-gradient(circle at top right, rgba(188,106,25,0.09), transparent 22%),
          linear-gradient(180deg, #f8f6f0 0%, #ece4d6 100%);
        color: var(--ink);
      }
      .shell {
        max-width: 1440px;
        margin: 0 auto;
        padding: 28px 24px 40px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 38px;
        letter-spacing: 1px;
      }
      .sub {
        margin-bottom: 24px;
        color: var(--muted);
      }
      .hero {
        display: grid;
        grid-template-columns: 1.3fr 0.7fr;
        gap: 18px;
        margin-bottom: 18px;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 18px;
      }
      .panel {
        background:
          linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.84) 100%);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 18px;
        box-shadow: 0 20px 46px rgba(23, 33, 38, 0.08);
        backdrop-filter: blur(10px);
      }
      .panel h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
      }
      .summary-card {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid rgba(20,92,89,0.12);
        background: linear-gradient(180deg, rgba(20,92,89,0.08), rgba(255,255,255,0.88));
      }
      .summary-label {
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 8px;
      }
      .summary-value {
        font-size: 32px;
        font-weight: 700;
      }
      .list {
        display: grid;
        gap: 10px;
      }
      .card {
        border: 1px solid rgba(20,92,89,0.14);
        border-radius: 16px;
        padding: 14px;
        background: rgba(255,255,255,0.78);
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
        margin-bottom: 8px;
      }
      .card-title {
        font-size: 16px;
        font-weight: 700;
      }
      .card-sub {
        font-size: 12px;
        color: var(--muted);
      }
      .progress {
        margin: 12px 0 10px;
      }
      .progress-track {
        height: 10px;
        border-radius: 999px;
        background: rgba(20,92,89,0.08);
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #1d7a72 0%, #c58a34 100%);
      }
      .progress-meta {
        display: flex;
        justify-content: space-between;
        margin-top: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      .meta {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--muted);
        margin-top: 6px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 3px 9px;
        border-radius: 999px;
        background: var(--accent-soft);
      }
      .pill.warn { background: rgba(185,106,25,0.12); color: #8f5417; }
      .pill.bad { background: rgba(198,69,69,0.12); color: #9e3131; }
      .pill.good { background: rgba(30,123,87,0.12); color: #185f44; }
      .roles {
        display: grid;
        gap: 6px;
        margin-top: 10px;
      }
      .role-item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px 12px;
        font-size: 13px;
        padding: 7px 10px;
        border-radius: 12px;
        background: rgba(20,92,89,0.05);
      }
      .role-main {
        display: grid;
        gap: 2px;
      }
      .role-title {
        font-weight: 700;
      }
      .role-desc {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .role-state {
        color: var(--muted);
        align-self: center;
      }
      .detail-stack {
        display: grid;
        gap: 6px;
        margin-top: 10px;
        font-size: 12px;
        color: var(--muted);
      }
      .task-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .action-btn {
        border: 1px solid rgba(20,92,89,0.16);
        background: rgba(255,255,255,0.92);
        color: var(--ink);
        border-radius: 999px;
        padding: 8px 14px;
        cursor: pointer;
        font: inherit;
      }
      .action-btn:hover {
        background: rgba(20,92,89,0.08);
      }
      .action-btn.warn {
        border-color: rgba(185,106,25,0.25);
        color: #8f5417;
      }
      .action-btn.bad {
        border-color: rgba(198,69,69,0.28);
        color: #9e3131;
      }
      .action-btn[disabled] {
        opacity: 0.55;
        cursor: wait;
      }
      .detail-line {
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(20,92,89,0.05);
        line-height: 1.5;
      }
      .mono {
        font-family: "JetBrains Mono", "Fira Code", monospace;
      }
      .event-log {
        max-height: 70vh;
        overflow: auto;
      }
      .event-item {
        border-left: 3px solid rgba(20,92,89,0.25);
      }
      @media (max-width: 960px) {
        .hero,
        .grid {
          grid-template-columns: 1fr;
        }
        .summary-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1>IAI 实时监控看板</h1>
      <div class="sub">实时跟踪任务进度、角色分工、审核流程与模型节点状态。</div>
      <div class="hero">
        <section class="panel">
          <h2>总览</h2>
          <div class="summary-grid">
            <div class="summary-card">
              <div class="summary-label">任务总览</div>
              <div id="summary-tasks" class="summary-value">0</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">运行中</div>
              <div id="summary-running" class="summary-value">0</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">历史任务</div>
              <div id="summary-history" class="summary-value">0</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">活跃节点</div>
              <div id="summary-providers" class="summary-value">0</div>
            </div>
          </div>
        </section>
        <section class="panel">
          <h2>说明</h2>
          <div class="card">
            <div>卡片会展示：</div>
            <div class="roles">
              <div class="role-item"><span>中文状态</span><span class="role-state">当前处在哪个阶段</span></div>
              <div class="role-item"><span>进度条</span><span class="role-state">整体流程推进比例</span></div>
              <div class="role-item"><span>任务分工</span><span class="role-state">谁在起草、复审、审核、执行</span></div>
              <div class="role-item"><span>模型档位</span><span class="role-state">当前 preset、超时和审核回退链</span></div>
            </div>
          </div>
        </section>
      </div>
      <div class="grid">
        <section class="panel">
          <h2>运行中任务</h2>
          <div id="running-tasks" class="list"></div>
          <div style="height: 14px"></div>
          <h2>历史任务</h2>
          <div id="history-tasks" class="list"></div>
        </section>
        <section class="panel">
          <h2>心跳与 Provider</h2>
          <div id="heartbeats" class="list"></div>
          <div style="height: 12px"></div>
          <div id="providers" class="list"></div>
        </section>
      </div>
      <div style="height: 18px"></div>
      <section class="panel event-log">
        <h2>近期事件</h2>
        <div id="events" class="list"></div>
      </section>
    </div>
    <script>
      const statusLabels = {
        queued: "已排队",
        classifying: "任务识别中",
        routing: "链路规划中",
        skill_planning: "技能装配中",
        drafting: "草稿生成中",
        reviewing: "复审中",
        audit_pending: "审核中",
        audit_revising: "修订中",
        arbitrating: "仲裁定稿中",
        handoff_to_codex: "交接实现中",
        implementing: "实施中",
        testing: "测试中",
        completed: "已完成",
        failed: "已失败",
        needs_browser_launch: "等待模型窗口启动",
        provider_session_lost: "模型会话失联",
        needs_manual_login: "等待人工登录",
        needs_human_intervention: "等待人工介入"
      };
      const roleLabels = {
        crown_orchestrator: "舰长",
        zhongshu_drafter: "首席科学官",
        hanlin_reviewer: "大副",
        menxia_auditor: "安全官",
        zhongshu_arbiter: "通讯官",
        shangshu_executor: "轮机长",
        junji_implementer: "导航员",
        sitian_monitor: "瞭望塔"
      };
      const roleDescriptions = {
        crown_orchestrator: "负责统筹任务、选路由、安排各角色分工。",
        zhongshu_drafter: "负责先起草第一版答案或方案。",
        hanlin_reviewer: "负责复审草稿，挑问题、补细节、提修正建议。",
        menxia_auditor: "负责做最终审核把关，决定通过、修订或驳回。",
        zhongshu_arbiter: "负责综合草稿和复审意见，整理成最终版本。",
        shangshu_executor: "负责把最终内容落成文档、PPT、图片等产物。",
        junji_implementer: "负责具体实现、落地执行和测试。",
        sitian_monitor: "负责监控全流程状态、异常和进度播报。"
      };
      const presetLabels = {
        standard: "标准档",
        pro: "增强档",
        expert: "专家档",
        deep: "深度档"
      };
      const eventLabels = {
        "task.accepted": "任务已接收",
        "task.status_changed": "任务状态变更",
        "task.completed": "任务完成",
        "task.failed": "任务失败",
        "task.cache_hit": "命中缓存",
        "task.route_selected": "链路已选定",
        "task.skills_selected": "技能已装配",
        "provider.started": "节点开始执行",
        "provider.completed": "节点执行完成",
        "provider.failed": "节点执行失败",
        "audit.required": "进入审核",
        "audit.passed": "审核通过",
        "audit.revise_required": "要求修订",
        "audit.rejected": "审核驳回",
        "role.heartbeat": "角色心跳",
        "config.reloaded": "配置已重载",
        "config.reload_failed": "配置重载失败"
      };
      const tasksEl = document.getElementById("tasks");
      const heartbeatsEl = document.getElementById("heartbeats");
      const providersEl = document.getElementById("providers");
      const eventsEl = document.getElementById("events");
      const summaryTasksEl = document.getElementById("summary-tasks");
      const summaryRunningEl = document.getElementById("summary-running");
      const summaryHistoryEl = document.getElementById("summary-history");
      const summaryProvidersEl = document.getElementById("summary-providers");
      const runningTasksEl = document.getElementById("running-tasks");
      const historyTasksEl = document.getElementById("history-tasks");

      const FINAL_STATUSES = ["completed", "failed", "needs_browser_launch", "provider_session_lost", "needs_manual_login", "needs_human_intervention"];

      async function actOnTask(taskId, action, button) {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = action === "stop" ? "停止中..." : "转交中...";
        try {
          const response = await fetch("/tasks/" + taskId + "/" + action, {
            method: "POST"
          });
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error("请求失败: " + response.status + (text ? " · " + text : ""));
          }
          const monitorResponse = await fetch("/monitor");
          if (monitorResponse.ok) {
            render(await monitorResponse.json());
          }
        } catch (error) {
          alert(error instanceof Error ? error.message : String(error));
          button.disabled = false;
          button.textContent = original;
        }
      }

      window.handleTaskAction = (taskId, action, target) => {
        const button = target instanceof HTMLElement ? target : null;
        if (!button) return;
        actOnTask(taskId, action, button);
      };

      function progress(status) {
        const mapping = {
          queued: 5,
          classifying: 12,
          routing: 20,
          skill_planning: 28,
          drafting: 42,
          reviewing: 58,
          audit_pending: 74,
          audit_revising: 82,
          arbitrating: 88,
          handoff_to_codex: 90,
          implementing: 94,
          testing: 97,
          completed: 100,
          failed: 100,
          needs_browser_launch: 100,
          provider_session_lost: 100,
          needs_manual_login: 100,
          needs_human_intervention: 100
        };
        return mapping[status] || 0;
      }

      function getPresetLabel(preset) {
        return presetLabels[preset] || preset || "-";
      }

      function formatTimeout(timeoutMs) {
        if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return "-";
        return Math.round(timeoutMs / 1000) + " 秒";
      }

      function getCurrentRole(status) {
        if (status === "reviewing") return "hanlin_reviewer";
        if (status === "audit_pending" || status === "audit_revising") return "menxia_auditor";
        if (status === "arbitrating") return "zhongshu_arbiter";
        if (status === "handoff_to_codex" || status === "implementing" || status === "testing") return "junji_implementer";
        if (status === "completed") return null;
        return "zhongshu_drafter";
      }

      function getCurrentTarget(task) {
        const workflow = task.workflow || {};
        const modelPlan = workflow.modelPlan || {};
        const currentRole = getCurrentRole(task.status);
        if (!currentRole) return null;
        if (currentRole === "zhongshu_drafter") return modelPlan.drafter || null;
        if (currentRole === "hanlin_reviewer") return Array.isArray(modelPlan.reviewers) ? modelPlan.reviewers[0] : null;
        if (currentRole === "menxia_auditor") return modelPlan.auditor || null;
        if (currentRole === "zhongshu_arbiter") return modelPlan.arbiter || null;
        return null;
      }

      function getAuditTrail(task) {
        const workflow = task.workflow || {};
        const modelPlan = workflow.modelPlan || {};
        const targets = [];
        if (modelPlan.auditor) targets.push(modelPlan.auditor);
        if (Array.isArray(modelPlan.auditFallbacks)) targets.push(...modelPlan.auditFallbacks);
        return targets
          .filter(Boolean)
          .slice(0, 5)
          .map((target, index) => {
            const tag = index === 0 ? "主审核" : "回退 " + index;
            return tag + " · " + (target.provider || "-") + " · " + getPresetLabel(target.preset) + " · " + formatTimeout(target.timeoutMs);
          });
      }

      function renderTaskDetails(task) {
        const currentTarget = getCurrentTarget(task);
        const auditTrail = getAuditTrail(task);
        const lines = [];
        if (currentTarget) {
          lines.push('<div class="detail-line">当前执行 · ' + (currentTarget.provider || '-') + ' · ' + getPresetLabel(currentTarget.preset) + ' · ' + formatTimeout(currentTarget.timeoutMs) + '</div>');
        }
        if (auditTrail.length) {
          lines.push('<div class="detail-line">审核链 · ' + auditTrail.join(' → ') + '</div>');
        }
        return lines.length ? '<div class="detail-stack">' + lines.join('') + '</div>' : '';
      }

      function renderRoles(task) {
        const chain = task.rolePlan?.chain || [];
        if (!chain.length) return "";
        const currentRole = getCurrentRole(task.status);
        const currentIndex = currentRole ? chain.findIndex((item) => item.role === currentRole) : -1;
        return '<div class="roles">' + chain.slice(0, 6).map((item, index) => {
          let state = "待执行";
          if (task.status === "completed") state = "已完成";
          else if (["failed","needs_browser_launch","provider_session_lost","needs_manual_login","needs_human_intervention"].includes(task.status)) {
            if (currentIndex >= 0 && index < currentIndex) state = "已完成";
            else if (currentIndex >= 0 && index === currentIndex) state = "已受阻";
          } else if (currentIndex >= 0) {
            if (index < currentIndex) state = "已完成";
            else if (index === currentIndex) state = "进行中";
          }
          const title = item.title || roleLabels[item.role] || item.role;
          const provider = item.provider ? ' · ' + item.provider : '';
          const preset = item.preset ? ' · ' + getPresetLabel(item.preset) : '';
          const timeout = item.timeoutMs ? ' · ' + formatTimeout(item.timeoutMs) : '';
          const desc = roleDescriptions[item.role] || '负责该环节执行。';
          return '<div class="role-item"><div class="role-main"><div class="role-title">' + title + provider + preset + timeout + '</div><div class="role-desc">' + desc + '</div></div><span class="role-state">' + state + '</span></div>';
        }).join("") + '</div>';
      }

      function renderEventMeta(event) {
        const meta = event.meta || {};
        const lines = [];
        if (meta.preset) lines.push('<span class="pill">档位 ' + getPresetLabel(meta.preset) + '</span>');
        if (meta.timeoutMs) lines.push('<span class="pill">超时 ' + formatTimeout(meta.timeoutMs) + '</span>');
        if (Array.isArray(meta.targets) && meta.targets.length) {
          const chain = meta.targets.slice(0, 4).map((target) => (target.provider || '-') + '/' + getPresetLabel(target.preset)).join(' → ');
          lines.push('<span class="pill">审核链 ' + chain + '</span>');
        }
        return lines.join('');
      }

      function taskCard(task) {
        const percent = progress(task.status);
        const audit = task.audit?.required ? '<span class="pill warn">需要审核</span>' : '';
        const artifact = task.workflow?.artifactType && task.workflow?.artifactType !== 'none'
          ? '<span class="pill">产物 ' + task.workflow.artifactType + '</span>' : '';
        const currentTarget = getCurrentTarget(task);
        const currentPreset = currentTarget?.preset ? '<span class="pill">档位 ' + getPresetLabel(currentTarget.preset) + '</span>' : '';
        const currentTimeout = currentTarget?.timeoutMs ? '<span class="pill">超时 ' + formatTimeout(currentTarget.timeoutMs) + '</span>' : '';
        const canAct = !FINAL_STATUSES.includes(task.status);
        const actions = canAct ? \`
          <div class="task-actions">
            <button class="action-btn warn" onclick="handleTaskAction('\${task.taskId}', 'intervene', this)">人工介入</button>
            <button class="action-btn bad" onclick="handleTaskAction('\${task.taskId}', 'stop', this)">停止任务</button>
          </div>
        \` : '';
        return \`
          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">\${task.taskId}</div>
                <div class="card-sub">\${task.summary || '-'}</div>
              </div>
              <div class="pill \${task.status === 'completed' ? 'good' : (task.status === 'failed' || task.status === 'needs_browser_launch' || task.status === 'provider_session_lost' || task.status === 'needs_manual_login' || task.status === 'needs_human_intervention') ? 'bad' : ''}">\${statusLabels[task.status] || task.status}</div>
            </div>
            <div class="progress">
              <div class="progress-track"><div class="progress-fill" style="width:\${percent}%"></div></div>
              <div class="progress-meta"><span>流程进度</span><span>\${percent}%</span></div>
            </div>
            <div class="meta">
              <span class="pill">意图 \${task.workflow?.intent || '-'}</span>
              <span class="pill">质量 \${task.workflow?.qualityLevel || '-'}</span>
              <span class="pill">节点 \${task.lastProvider || '-'}</span>
              \${currentPreset}
              \${currentTimeout}
              \${artifact}
              \${audit}
            </div>
            \${renderTaskDetails(task)}
            \${renderRoles(task)}
            \${actions}
          </div>
        \`;
      }

      function render(snapshot) {
        const tasks = snapshot.activeTasks || [];
        const runningTasks = tasks.filter((task) => !FINAL_STATUSES.includes(task.status));
        const historyTasks = tasks.filter((task) => FINAL_STATUSES.includes(task.status));
        const providers = snapshot.providers || [];
        summaryTasksEl.textContent = String(tasks.length);
        summaryRunningEl.textContent = String(runningTasks.length);
        summaryHistoryEl.textContent = String(historyTasks.length);
        summaryProvidersEl.textContent = String(providers.filter((item) => item.lastStatus === "running").length);

        runningTasksEl.innerHTML = runningTasks.map(taskCard).join('') || '<div class="card">暂无运行中任务</div>';
        historyTasksEl.innerHTML = historyTasks.map(taskCard).join('') || '<div class="card">暂无历史任务</div>';

        heartbeatsEl.innerHTML = (snapshot.heartbeats || []).map((item) => \`
          <div class="card">
            <div class="card-head">
              <div class="card-title">\${roleLabels[item.role] || item.role}\${item.provider ? ' · ' + item.provider : ''}</div>
              <div class="pill">\${item.state === 'running' ? '执行中' : item.state === 'error' ? '异常' : item.state === 'waiting' ? '等待中' : '空闲'}</div>
            </div>
            <div class="card-sub">\${item.detail || '-'}</div>
            <div class="meta"><span class="pill">\${item.seenAt}</span></div>
          </div>
        \`).join('') || '<div class="card">暂无心跳</div>';

        providersEl.innerHTML = providers.map((item) => \`
          <div class="card">
            <div class="card-head">
              <div class="card-title">\${item.provider}</div>
              <div class="pill \${item.lastStatus === 'success' ? 'good' : item.lastStatus === 'failed' ? 'bad' : ''}">
                \${item.lastStatus === 'running' ? '运行中' : item.lastStatus === 'success' ? '最近成功' : item.lastStatus === 'failed' ? '最近失败' : '空闲'}
              </div>
            </div>
            <div class="meta">
              <span class="pill">调用 \${item.totalCalls}</span>
              <span class="pill">失败 \${item.failures}</span>
              <span class="pill">最近 \${item.lastSeenAt || '-'}</span>
            </div>
          </div>
        \`).join('') || '<div class="card">暂无 provider 数据</div>';

        eventsEl.innerHTML = (snapshot.recentEvents || []).map((event) => \`
          <div class="card event-item">
            <div class="card-head">
              <div class="card-title">\${eventLabels[event.type] || event.type}</div>
              <div class="pill">\${statusLabels[event.status] || event.status || '-'}</div>
            </div>
            <div class="card-sub">\${event.detail || '-'}</div>
            <div class="meta">
              <span class="pill">任务 \${event.taskId || '-'}</span>
              <span class="pill">角色 \${roleLabels[event.role] || event.role || '-'}</span>
              <span class="pill">节点 \${event.provider || '-'}</span>
              \${renderEventMeta(event)}
              <span class="pill">\${event.timestamp}</span>
            </div>
          </div>
        \`).join('') || '<div class="card">暂无事件</div>';
      }

      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(protocol + "://" + location.host + "/monitor/ws");
      ws.onmessage = (message) => {
        const payload = JSON.parse(message.data);
        if (payload.snapshot) {
          render(payload.snapshot);
        }
      };
    </script>
  </body>
</html>`;
}
