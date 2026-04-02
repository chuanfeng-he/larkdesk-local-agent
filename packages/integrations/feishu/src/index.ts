import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ModelPresetName, TaskComplexity, TaskNotifier, TaskRiskLevel, TaskStore, TaskSubmission, TaskType } from "@office-agent/core";
import { hasRealtimeInfoNeed, inferArtifactType, inferAuditPolicy, inferTaskIntent, redactSensitiveText, summarizeText } from "@office-agent/core";
import type { TaskQualityLevel, TaskRecord } from "@office-agent/core";
import * as Lark from "@larksuiteoapi/node-sdk";

export interface FeishuEnvConfig {
  webhookUrl?: string;
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  useLongConnection?: boolean;
  defaultChatId?: string;
}

interface AccessTokenResponse {
  tenant_access_token: string;
  expire: number;
}

interface FeishuSubmissionDraft
  extends Pick<
    TaskSubmission,
    | "input"
    | "requestedType"
    | "sourceMeta"
    | "requestedIntent"
    | "artifactType"
    | "requiresAudit"
    | "qualityLevel"
    | "riskLevel"
    | "complexity"
    | "presetHints"
    | "executionPolicy"
  > {}

export interface FeishuTaskController {
  stopTask(taskId: string): Promise<TaskRecord | null>;
  interveneTask(taskId: string): Promise<TaskRecord | null>;
  approveTask(taskId: string): Promise<TaskRecord | null>;
}

interface FeishuBotAppOptions {
  workspaceRoot?: string;
  auditConfirmTimeoutMs?: number;
}

interface PendingAuditRequest {
  scopeKey: string;
  text: string;
  sourceMeta: Record<string, unknown>;
  chatId: string;
  openId?: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class FeishuNotifier implements TaskNotifier {
  constructor(private readonly config: FeishuEnvConfig) {}

  async notifyTaskAccepted(task: TaskRecord): Promise<void> {
    if (task.source === "scheduler") {
      return;
    }
    // T0/T1 tasks skip acceptance notification (fast path returns result directly)
    const workflow = ((task.sourceMeta ?? {}) as Record<string, unknown>).workflow as Record<string, unknown> | undefined;
    const tier = workflow?.tier as string | undefined;
    if (tier === "T0" || tier === "T1") {
      return;
    }
    await this.pushText(`收到啦，马上安排～\n摘要: ${task.summary ?? task.userInput}`);
  }

  async notifyTaskCompleted(task: TaskRecord): Promise<void> {
    if (task.source === "scheduler") {
      return;
    }
    const answer = typeof task.result?.answer === "string" ? task.result.answer : task.outputSummary ?? "任务已完成";
    await this.pushCard({
      header: `搞定啦！✨ · ${task.type}`,
      lines: [
        `摘要: ${task.summary ?? "-"}`,
        `结果: ${summarizeText(answer, 600)}`,
      ],
    });
  }

  async notifyTaskFailed(task: TaskRecord): Promise<void> {
    if (task.source === "scheduler") {
      return;
    }
    await this.pushCard({
      header: `没处理成功 😞 · ${task.type}`,
      lines: [
        `摘要: ${task.summary ?? "-"}`,
        `问题: ${summarizeText(task.error ?? "unknown", 400)}`,
      ],
    });
  }

  async notifyProviderAttention(provider: string, detail: string, hint?: string): Promise<void> {
    await this.pushCard({
      header: `Provider 需要人工恢复登录`,
      lines: [
        `Provider: ${provider}`,
        `原因: ${summarizeText(detail, 240)}`,
        `建议: ${hint ?? "请使用独立 profile 手动登录后再重试。"}`,
      ],
    });
  }

  async pushText(text: string): Promise<void> {
    if (!this.config.webhookUrl) {
      return;
    }

    const response = await fetch(this.config.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "text",
        content: {
          text: redactSensitiveText(text),
        },
      }),
    });

    await assertOk(response, "Feishu webhook text push failed");
  }

  async pushCard(input: { header: string; lines: string[] }): Promise<void> {
    if (!this.config.webhookUrl) {
      return;
    }

    const response = await fetch(this.config.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "interactive",
        card: {
          header: {
            title: {
              tag: "plain_text",
              content: input.header,
            },
          },
          elements: input.lines.map((line) => ({
            tag: "div",
            text: {
              tag: "lark_md",
              content: redactSensitiveText(line),
            },
          })),
        },
      }),
    });

    await assertOk(response, "Feishu webhook card push failed");
  }
}

export class NoopNotifier implements TaskNotifier {
  async notifyTaskAccepted(): Promise<void> {}
  async notifyTaskCompleted(): Promise<void> {}
  async notifyTaskFailed(): Promise<void> {}
  async notifyProviderAttention(): Promise<void> {}
}

export class CompositeNotifier implements TaskNotifier {
  constructor(private readonly notifiers: TaskNotifier[]) {}

  async notifyTaskAccepted(task: TaskRecord): Promise<void> {
    await Promise.all(this.notifiers.map((notifier) => notifier.notifyTaskAccepted(task)));
  }

  async notifyTaskCompleted(task: TaskRecord): Promise<void> {
    await Promise.all(this.notifiers.map((notifier) => notifier.notifyTaskCompleted(task)));
  }

  async notifyTaskFailed(task: TaskRecord): Promise<void> {
    await Promise.all(this.notifiers.map((notifier) => notifier.notifyTaskFailed(task)));
  }

  async notifyProviderAttention(provider: string, detail: string, hint?: string): Promise<void> {
    await Promise.all(this.notifiers.map((notifier) => notifier.notifyProviderAttention(provider, detail, hint)));
  }
}

export class FeishuBotApp {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private wsClient: Lark.WSClient | null = null;
  private readonly processedMessageIds = new Map<string, number>();
  private readonly pendingAuditRequests = new Map<string, PendingAuditRequest>();
  private taskController: FeishuTaskController | null = null;

  constructor(
    private readonly config: FeishuEnvConfig,
    private readonly taskExecutor: {
      submitTask(submission: TaskSubmission): Promise<{ taskId: string; taskType: string }>;
    },
    private readonly taskStore: TaskStore,
    private readonly options: FeishuBotAppOptions = {},
  ) {}

  async handleEvent(body: Record<string, any>): Promise<Record<string, unknown>> {
    if (body.type === "url_verification") {
      return {
        challenge: body.challenge,
      };
    }

    if (!this.validateToken(body)) {
      return {
        code: 401,
        msg: "invalid verification token",
      };
    }

    const eventType = body.header?.event_type;
    if (eventType !== "im.message.receive_v1") {
      return {
        code: 0,
        msg: "ignored",
      };
    }

    await this.handleIncomingMessageEvent(body.event);
    return { code: 0, msg: "ok" };
  }

  async startLongConnection(): Promise<boolean> {
    if (!this.config.useLongConnection) {
      return false;
    }

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("Feishu app credentials are missing for long connection mode.");
    }

    if (this.wsClient) {
      return true;
    }

    const dispatcher = new Lark.EventDispatcher({
      verificationToken: this.config.verificationToken,
    }).register({
      "im.message.receive_v1": async (data: Record<string, any>) => {
        await this.handleIncomingMessageEvent(data);
        return {
          code: 0,
          msg: "ok",
        };
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
    return true;
  }

  close(): void {
    for (const pending of this.pendingAuditRequests.values()) {
      clearTimeout(pending.timeoutHandle);
    }
    this.pendingAuditRequests.clear();
    this.wsClient?.close({ force: true });
    this.wsClient = null;
  }

  setTaskController(controller: FeishuTaskController | null): void {
    this.taskController = controller;
  }

  async replyTaskResult(task: TaskRecord): Promise<void> {
    const sourceMeta = task.sourceMeta ?? {};
    const chatId = this.resolveTaskChatId(task);
    const messageId = typeof sourceMeta.messageId === "string" ? sourceMeta.messageId : undefined;
    if (!chatId) {
      return;
    }

    const answer =
      typeof task.result?.answer === "string"
        ? task.result.answer
        : task.outputSummary
          ? task.outputSummary
          : typeof task.result?.finalPlan === "string"
            ? task.result.finalPlan
            : "任务已完成";
    const provider = typeof task.result?.provider === "string" ? task.result.provider : undefined;
    const workflow = sourceMeta.workflow && typeof sourceMeta.workflow === "object" ? (sourceMeta.workflow as Record<string, unknown>) : undefined;
    const imageArtifacts = extractImageArtifacts(task);

    if (workflow?.intent === "image") {
      await this.replyImageTaskResult(task, chatId, answer, provider, messageId);
      return;
    }

    if (imageArtifacts.length > 0) {
      await this.replyGenericImageTaskResult(task, chatId, answer, provider, messageId);
      return;
    }

    if (workflow?.intent === "doc") {
      await this.replyDocumentTaskResult(task, chatId, answer, provider, messageId);
      return;
    }

    // Simple QA: send plain text + separate thought process card
    const isSimpleChat = task.type === "SIMPLE" && (workflow?.intent === "qa" || workflow?.intent == null);
    const result = (task.result ?? {}) as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts) ? (result.artifacts as Array<Record<string, unknown>>) : [];

    if (isSimpleChat && artifacts.length === 0) {
      const plainAnswer = formatUserFacingAnswer(answer, provider, 3000) || "已处理完成。";
      if (messageId) {
        await this.replyToMessage(messageId, plainAnswer);
      } else {
        await this.sendTextToChat(chatId, plainAnswer);
      }

      const providerLabel = buildProviderLabel(task, provider);
      const thoughtLines = buildThoughtProcessLines(task, providerLabel);
      if (thoughtLines.length > 0) {
        const thoughtCard = buildCard({
          title: "执行链路与过程",
          template: "grey",
          lines: [],
          elements: buildThoughtProcessPanel(thoughtLines),
        });
        if (messageId) {
          await this.replyCardToMessage(messageId, thoughtCard);
        } else {
          await this.sendCardToChat(chatId, thoughtCard);
        }
      }
      return;
    }

    const card = buildCompletionCard(task, answer, provider);
    if (messageId) {
      await this.replyCardToMessage(messageId, card);
    } else {
      await this.sendCardToChat(chatId, card);
    }
  }

  async replyTaskProgress(task: TaskRecord): Promise<void> {
    const chatId = this.resolveTaskChatId(task);
    if (!chatId) {
      return;
    }

    await this.sendTextToChat(chatId, buildProgressText(task));
  }

  async replyTaskFailure(task: TaskRecord): Promise<void> {
    const sourceMeta = task.sourceMeta ?? {};
    const chatId = this.resolveTaskChatId(task);
    const messageId = typeof sourceMeta.messageId === "string" ? sourceMeta.messageId : undefined;
    const workflow = sourceMeta.workflow && typeof sourceMeta.workflow === "object" ? (sourceMeta.workflow as Record<string, unknown>) : undefined;
    if (!chatId) {
      return;
    }

    if (workflow?.intent === "image") {
      const text = `这次图片没出成功，${summarizeText(task.error ?? "出了点问题", 120)}。你可以再发一次，我继续帮你盯着。`;
      if (messageId) {
        await this.replyToMessage(messageId, text);
      } else {
        await this.sendTextToChat(chatId, text);
      }
      return;
    }

    const text = buildFailureText(task);
    if (messageId) {
      await this.replyCardToMessage(messageId, buildFailureCard(task));
    } else {
      await this.sendCardToChat(chatId, buildFailureCard(task));
    }
  }

  async pushWebhookTestMessage(text: string): Promise<void> {
    const notifier = new FeishuNotifier(this.config);
    await notifier.pushText(text);
  }

  async getTaskStatusMessage(taskId: string): Promise<string> {
    const task = await this.taskStore.getTask(taskId);

    if (!task) {
      return `未找到任务 ${taskId}`;
    }

    return `任务ID：${task.id}\n类型：${task.type}\n状态：${task.status}\n摘要：${task.summary ?? "-"}\n结果：${task.outputSummary ?? "-"}`;
  }

  async pushTextToDefaultChat(text: string): Promise<void> {
    const chatId = this.config.defaultChatId;
    if (!chatId) {
      return;
    }

    await this.sendTextToChat(chatId, text);
  }

  async pushTextToChat(chatId: string, text: string): Promise<void> {
    await this.sendTextToChat(chatId, text);
  }

  private async handleIncomingMessageEvent(event: Record<string, any>): Promise<void> {
    const messageId = event?.message?.message_id;
    if (typeof messageId === "string" && this.isDuplicateMessage(messageId)) {
      return;
    }

    const content = safeParseJson<Record<string, string>>(event?.message?.content);
    const text = content?.text?.trim();

    if (!text) {
      return;
    }

    const chatId = typeof event?.message?.chat_id === "string" ? event.message.chat_id : undefined;
    const openId = typeof event?.sender?.sender_id?.open_id === "string" ? event.sender.sender_id.open_id : undefined;

    const shortcutHandled = await this.tryHandleLocalShortcut(text, chatId, messageId);
    if (shortcutHandled) {
      return;
    }

    if (parseAuthorizationReply(text) && this.taskController && chatId) {
      const approvableTask = await this.findLatestAuthorizableTaskForChat(chatId);
      if (approvableTask) {
        const updated = await this.taskController.approveTask(approvableTask.id);
        if (updated && typeof messageId === "string") {
          await this.replyToMessage(messageId, "已批准，继续执行");
        }
        return;
      }
    }

    const command = parseTaskCommand(text);
    if (command && typeof messageId === "string") {
      if (command.action === "models") {
        await this.replyToMessage(messageId, buildAvailableModelsText());
        return;
      }

      const task = command.taskId
        ? await this.taskStore.getTask(command.taskId)
        : chatId
          ? await this.findLatestTaskForChat(chatId, command.action !== "status")
          : null;

      if (!task) {
        await this.replyToMessage(messageId, command.taskId ? `未找到任务 ${command.taskId}` : "当前会话里没有可操作的任务。");
        return;
      }

      if (command.action === "status") {
        await this.replyToMessage(messageId, buildProgressText(task, true));
        return;
      }

      if (command.action === "current_model") {
        await this.replyToMessage(messageId, buildCurrentModelText(task));
        return;
      }

      if (command.action === "upgrade") {
        const followupText = command.followupText ?? "请基于同一问题重新回答，显著提高专业性、严谨性和信息密度，必要时先给定义，再分点说明关键特征、优缺点、适用条件与边界。";
        const upgradedInput = buildContinuationInput(task, followupText, "upgrade");
        const continuationMeta = buildContinuationMeta(task, followupText);
        const inferredSubmission = buildFeishuSubmission(upgradedInput, {
          chatId,
          messageId,
          openId,
          upgradedFromTaskId: task.id,
          continuedFromTaskId: task.id,
          interventionSourceTaskId: task.id,
          continuation: continuationMeta,
        }, {
          auditPreference: false,
        });
        inferredSubmission.requestedType = task.type === "SIMPLE" ? "COMPLEX" : inferredSubmission.requestedType ?? task.type;
        inferredSubmission.qualityLevel = upgradeQualityLevel(inferredSubmission.qualityLevel, followupText);
        inferredSubmission.presetHints = {
          ...(inferredSubmission.presetHints ?? {}),
          preferredReasoning: upgradePresetHint(inferredSubmission.presetHints?.preferredReasoning, followupText),
        };
        const submission = await this.submitDraftedTask(inferredSubmission);
        await this.replyToMessage(messageId, `收到，我按更专业的标准重新处理。\n任务 ${submission.taskId}`);
        return;
      }

      if (command.action === "continue") {
        const mergedInput = buildContinuationInput(task, command.followupText, "continue");
        const continuationMeta = buildContinuationMeta(task, command.followupText);
        const inferredSubmission = buildFeishuSubmission(mergedInput, {
          chatId,
          messageId,
          openId,
          continuedFromTaskId: task.id,
          interventionSourceTaskId: task.id,
          continuation: continuationMeta,
        });
        const submission = await this.submitDraftedTask(inferredSubmission);
        await this.replyToMessage(messageId, buildAcceptedText(submission.taskId, submission.taskType, inferredSubmission.input));
        return;
      }

      if (!this.taskController) {
        await this.replyToMessage(messageId, "当前服务还没有接入任务控制器，暂时无法执行该指令。");
        return;
      }

      const updated =
        command.action === "stop"
          ? await this.taskController.stopTask(task.id)
          : await this.taskController.interveneTask(task.id);

      if (!updated) {
        await this.replyToMessage(messageId, `未找到任务 ${task.id}`);
        return;
      }

      if (command.action === "stop") {
        await this.replyToMessage(messageId, buildFailureText(updated));
      } else {
        await this.replyToMessage(messageId, buildProgressText(updated, true));
      }
      return;
    }

    const sourceMeta = {
      chatId,
      messageId,
      openId,
    };
    const explicitAuditPreference = parseFeishuDirectives(text).requiresAudit;

    await this.submitFeishuTask(text, sourceMeta, {
      acceptedReplyMessageId: messageId,
      auditPreference: explicitAuditPreference ?? false,
    });
  }

  private async submitDraftedTask(draft: FeishuSubmissionDraft): Promise<{ taskId: string; taskType: string }> {
    return this.taskExecutor.submitTask({
      input: draft.input,
      source: "feishu",
      sourceMeta: draft.sourceMeta,
      requestedType: draft.requestedType,
      requestedIntent: draft.requestedIntent,
      artifactType: draft.artifactType,
      requiresAudit: draft.requiresAudit,
      qualityLevel: draft.qualityLevel,
      riskLevel: draft.riskLevel,
      complexity: draft.complexity,
      presetHints: draft.presetHints,
      executionPolicy: draft.executionPolicy,
    });
  }

  private async submitFeishuTask(
    text: string,
    sourceMeta: Record<string, unknown>,
    options?: {
      acceptedReplyMessageId?: string;
      auditPreference?: boolean;
    },
  ): Promise<void> {
    const inferredSubmission = buildFeishuSubmission(text, sourceMeta, {
      auditPreference: options?.auditPreference,
    });
    const submission = await this.submitDraftedTask(inferredSubmission);

    if (options?.acceptedReplyMessageId) {
      await this.replyToMessage(options.acceptedReplyMessageId, buildAcceptedText(submission.taskId, submission.taskType, inferredSubmission.input));
    }
  }

  private async queueAuditConfirmation(
    text: string,
    sourceMeta: Record<string, unknown>,
    chatId: string,
    openId: string | undefined,
    messageId: string | undefined,
    scopeKey: string,
  ): Promise<void> {
    const timeoutHandle = setTimeout(() => {
      const pending = this.pendingAuditRequests.get(scopeKey);
      if (!pending) {
        return;
      }

      this.clearPendingAuditRequest(scopeKey);
      void this.submitFeishuTask(pending.text, pending.sourceMeta, {
        auditPreference: false,
      }).catch((error: unknown) => {
        console.error("Failed to auto-submit task after audit timeout:", error);
      });
    }, this.options.auditConfirmTimeoutMs ?? 10_000);

    this.pendingAuditRequests.set(scopeKey, {
      scopeKey,
      text,
      sourceMeta,
      chatId,
      openId,
      timeoutHandle,
    });

    const prompt = "需要审核吗？10 秒内回复“要”或“不要”。不回复我就直接处理。";
    if (messageId) {
      await this.replyToMessage(messageId, prompt);
      return;
    }

    await this.sendTextToChat(chatId, prompt);
  }

  private async resolvePendingAuditRequest(
    pending: PendingAuditRequest,
    auditDecision: boolean,
    replyMessageId?: string,
  ): Promise<void> {
    this.clearPendingAuditRequest(pending.scopeKey);
    await this.submitFeishuTask(pending.text, pending.sourceMeta, {
      acceptedReplyMessageId: replyMessageId,
      auditPreference: auditDecision,
    });
  }

  private clearPendingAuditRequest(scopeKey: string): void {
    const pending = this.pendingAuditRequests.get(scopeKey);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutHandle);
    this.pendingAuditRequests.delete(scopeKey);
  }

  private getAuditScopeKey(chatId?: string, openId?: string): string | undefined {
    if (!chatId) {
      return undefined;
    }

    return `${chatId}:${openId ?? "anonymous"}`;
  }

  private async tryHandleLocalShortcut(text: string, chatId?: string, messageId?: string): Promise<boolean> {
    const targetLabel = parseOpenFolderTarget(text);
    if (!targetLabel) {
      return false;
    }

    const targetPath = await resolveFolderTarget(targetLabel, this.options.workspaceRoot);
    const reply = async (content: string) => {
      if (messageId) {
        await this.replyToMessage(messageId, content);
      } else if (chatId) {
        await this.sendTextToChat(chatId, content);
      }
    };

    if (!targetPath) {
      await reply(`没找到 ${targetLabel} 对应的文件夹。`);
      return true;
    }

    const opened = await openFolderInDesktop(targetPath);
    await reply(opened ? `已打开 ${targetPath}` : `没能打开 ${targetPath}，请检查桌面环境或权限。`);
    return true;
  }

  private isDuplicateMessage(messageId: string): boolean {
    const now = Date.now();
    for (const [key, seenAt] of this.processedMessageIds.entries()) {
      if (now - seenAt > 30 * 60_000) {
        this.processedMessageIds.delete(key);
      }
    }

    if (this.processedMessageIds.has(messageId)) {
      return true;
    }

    this.processedMessageIds.set(messageId, now);
    return false;
  }

  private validateToken(body: Record<string, any>): boolean {
    if (!this.config.verificationToken) {
      return true;
    }

    const token = body?.header?.token ?? body?.token;
    return token === this.config.verificationToken;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.value;
    }

    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("Feishu app credentials are missing.");
    }

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Feishu tenant access token: ${response.status}`);
    }

    const data = (await response.json()) as AccessTokenResponse;
    this.cachedToken = {
      value: data.tenant_access_token,
      expiresAt: now + data.expire * 1_000,
    };

    return data.tenant_access_token;
  }

  private async replyToMessage(messageId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: JSON.stringify({ text: redactSensitiveText(text) }),
        msg_type: "text",
      }),
    });

    await assertOk(response, "Feishu reply-to-message failed");
  }

  private async replyCardToMessage(messageId: string, card: Record<string, unknown>): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: JSON.stringify(card),
        msg_type: "interactive",
      }),
    });

    await assertOk(response, "Feishu reply-card failed");
  }

  private async sendTextToChat(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text: redactSensitiveText(text) }),
      }),
    });

    await assertOk(response, "Feishu send-to-chat failed");
  }

  private async sendCardToChat(chatId: string, card: Record<string, unknown>): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    });

    await assertOk(response, "Feishu send-card-to-chat failed");
  }

  private async replyImageTaskResult(
    task: TaskRecord,
    chatId: string,
    answer: string,
    _provider: string | undefined,
    messageId: string | undefined,
  ): Promise<void> {
    const imageArtifacts = extractImageArtifacts(task).slice(0, 4);
    if (imageArtifacts.length === 0) {
      if (messageId) {
        await this.replyToMessage(messageId, buildFriendlyImageText(0, answer));
        return;
      }

      await this.sendTextToChat(chatId, buildFriendlyImageText(0, answer));
      return;
    }

    const uploadedImageKeys: string[] = [];
    const uploadErrors: string[] = [];
    for (const artifact of imageArtifacts) {
      const imageKey = await this.uploadImage(artifact.path).catch((error: unknown) => {
        uploadErrors.push(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (imageKey) {
        uploadedImageKeys.push(imageKey);
      }
    }

    if (uploadedImageKeys.length === 0) {
      const failureText = buildImageUploadFailureText(uploadErrors[0], imageArtifacts.length);
      if (messageId) {
        await this.replyToMessage(messageId, failureText);
        return;
      }

      await this.sendTextToChat(chatId, failureText);
      return;
    }

    for (const imageKey of uploadedImageKeys) {
      await this.sendImageToChat(chatId, imageKey);
    }
    if (messageId) {
      await this.replyToMessage(messageId, buildFriendlyImageText(uploadedImageKeys.length, answer));
      return;
    }

    await this.sendTextToChat(chatId, buildFriendlyImageText(uploadedImageKeys.length, answer));
  }

  private async replyDocumentTaskResult(
    task: TaskRecord,
    chatId: string,
    answer: string,
    provider: string | undefined,
    messageId?: string,
  ): Promise<void> {
    const documentArtifacts = extractDocumentArtifacts(task);
    const docxArtifact = documentArtifacts.find((artifact) => /\.docx$/iu.test(artifact.path));
    let uploadedFileKey: string | null = null;
    let uploadError: string | undefined;

    if (docxArtifact) {
      uploadedFileKey = await this.uploadFile(docxArtifact.path).catch((error: unknown) => {
        uploadError = error instanceof Error ? error.message : String(error);
        return null;
      });
    }

    if (uploadedFileKey) {
      if (messageId) {
        await this.replyFileToMessage(messageId, uploadedFileKey);
      } else {
        await this.sendFileToChat(chatId, uploadedFileKey);
      }
    } else if (docxArtifact) {
      const failureText = buildDocumentUploadFailureText(uploadError, docxArtifact.path);
      if (messageId) {
        await this.replyToMessage(messageId, failureText);
      } else {
        await this.sendTextToChat(chatId, failureText);
      }
    }

    const text = buildCompletionText(task, answer, provider);
    if (messageId) {
      await this.replyToMessage(messageId, text);
    } else {
      await this.sendTextToChat(chatId, text);
    }
  }

  private async replyGenericImageTaskResult(
    task: TaskRecord,
    chatId: string,
    answer: string,
    provider: string | undefined,
    messageId?: string,
  ): Promise<void> {
    const imageArtifacts = extractImageArtifacts(task).slice(0, 4);
    if (imageArtifacts.length === 0) {
      const text = buildCompletionText(task, answer, provider);
      if (messageId) {
        await this.replyToMessage(messageId, text);
      } else {
        await this.sendTextToChat(chatId, text);
      }
      return;
    }

    const uploadedImageKeys: string[] = [];
    const uploadErrors: string[] = [];
    for (const artifact of imageArtifacts) {
      const imageKey = await this.uploadImage(artifact.path).catch((error: unknown) => {
        uploadErrors.push(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (imageKey) {
        uploadedImageKeys.push(imageKey);
      }
    }

    if (uploadedImageKeys.length === 0) {
      const failureText = buildImageUploadFailureText(uploadErrors[0], imageArtifacts.length);
      if (messageId) {
        await this.replyToMessage(messageId, failureText);
        return;
      }

      await this.sendTextToChat(chatId, failureText);
      return;
    }

    for (const imageKey of uploadedImageKeys) {
      await this.sendImageToChat(chatId, imageKey);
    }
    if (messageId) {
      await this.replyToMessage(messageId, buildGenericImageText(uploadedImageKeys.length, answer, provider));
      return;
    }

    await this.sendTextToChat(chatId, buildGenericImageText(uploadedImageKeys.length, answer, provider));
  }

  private async uploadImage(filePath: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    try {
      return await this.tryUploadImage(token, filePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!isFeishuImageTooLargeError(detail)) {
        throw error;
      }

      const optimized = await createOptimizedFeishuImage(filePath);
      try {
        return await this.tryUploadImage(token, optimized.path);
      } finally {
        await optimized.cleanup().catch(() => undefined);
      }
    }
  }

  private async tryUploadImage(token: string, filePath: string): Promise<string> {
    const form = new FormData();
    const buffer = await readFile(filePath);
    form.set("image_type", "message");
    form.set("image", new Blob([buffer]), basename(filePath));

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: form,
    });

    const bodyText = await response.text().catch(() => "");
    const payload = safeParseJson<{ code?: number; msg?: string; data?: { image_key?: string } }>(bodyText) as
      | { code?: number; msg?: string; data?: { image_key?: string } }
      | null;

    if (!response.ok) {
      throw new Error(`Feishu image upload failed: ${response.status} ${payload?.msg ?? bodyText.slice(0, 240)}`);
    }

    const imageKey = payload?.data?.image_key;
    if (!imageKey) {
      throw new Error(`Feishu image upload returned no image_key: ${payload?.msg ?? bodyText.slice(0, 240)}`);
    }

    return imageKey;
  }

  private async uploadFile(filePath: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    const buffer = await readFile(filePath);
    form.set("file_type", "stream");
    form.set("file_name", basename(filePath));
    form.set("file", new Blob([buffer]), basename(filePath));

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: form,
    });

    const bodyText = await response.text().catch(() => "");
    const payload = safeParseJson<{ code?: number; msg?: string; data?: { file_key?: string } }>(bodyText) as
      | { code?: number; msg?: string; data?: { file_key?: string } }
      | null;

    if (!response.ok) {
      throw new Error(`Feishu file upload failed: ${response.status} ${payload?.msg ?? bodyText.slice(0, 240)}`);
    }

    const fileKey = payload?.data?.file_key;
    if (!fileKey) {
      throw new Error(`Feishu file upload returned no file_key: ${payload?.msg ?? bodyText.slice(0, 240)}`);
    }

    return fileKey;
  }

  private async replyImageToMessage(messageId: string, imageKey: string): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: "image",
      }),
    });

    await assertOk(response, "Feishu reply-image failed");
  }

  private async sendImageToChat(chatId: string, imageKey: string): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      }),
    });

    await assertOk(response, "Feishu send-image-to-chat failed");
  }

  private async replyFileToMessage(messageId: string, fileKey: string): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: "file",
      }),
    });

    await assertOk(response, "Feishu reply-file failed");
  }

  private async sendFileToChat(chatId: string, fileKey: string): Promise<void> {
    const token = await this.getTenantAccessToken();

    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      }),
    });

    await assertOk(response, "Feishu send-file-to-chat failed");
  }

  private async findLatestTaskForChat(chatId: string, preferActive = true): Promise<TaskRecord | null> {
    const items = await this.taskStore.listTasks(60);
    const terminalStatuses = new Set(["completed", "failed", "needs_manual_login", "needs_human_intervention"]);
    terminalStatuses.add("needs_browser_launch");
    terminalStatuses.add("provider_session_lost");
    let latestAny: TaskRecord | null = null;

    for (const item of items) {
      const task = await this.taskStore.getTask(item.id);
      if (!task) {
        continue;
      }
      if (this.resolveTaskChatId(task) !== chatId) {
        continue;
      }
      if (!latestAny) {
        latestAny = task;
      }
      if (!preferActive || !terminalStatuses.has(task.status)) {
        return task;
      }
    }

    return latestAny;
  }

  private async findLatestAuthorizableTaskForChat(chatId: string): Promise<TaskRecord | null> {
    const items = await this.taskStore.listTasks(60);

    for (const item of items) {
      const task = await this.taskStore.getTask(item.id);
      if (!task) {
        continue;
      }

      const result = (task.result ?? {}) as Record<string, unknown>;
      if (this.resolveTaskChatId(task) !== chatId) {
        continue;
      }

      if (task.status === "needs_human_intervention" && result.authorizationPending === true) {
        return task;
      }
    }

    return null;
  }

  private resolveTaskChatId(task: TaskRecord): string | null {
    if (task.source === "scheduler") {
      return null;
    }

    const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
    if (typeof sourceMeta.chatId === "string" && sourceMeta.chatId.length > 0) {
      return sourceMeta.chatId;
    }

    if (sourceMeta.feishuNotify !== true) {
      return task.source === "feishu" && this.config.defaultChatId ? this.config.defaultChatId : null;
    }

    return this.config.defaultChatId ?? null;
  }
}

function safeParseJson<T>(input: string | undefined): T | null {
  if (!input) {
    return null;
  }

  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function parseTaskCommand(text: string): { action: "status" | "stop" | "intervene" | "continue" | "models" | "current_model" | "upgrade"; taskId?: string; followupText?: string } | null {
  const normalized = text.trim();

  if (/^(?:你有哪些模型|有哪些模型|可用模型|现在有哪些模型|你有的哪个模型)$/iu.test(normalized)) {
    return { action: "models" };
  }

  const currentModelMatch = normalized.match(/^(?:当前模型|现在用哪个模型|你用的是哪个模型|现在是哪个模型|当前用哪个模型)(?:\s+([a-z0-9]+))?$/iu);
  if (currentModelMatch) {
    return { action: "current_model", taskId: currentModelMatch[1] };
  }

  const queryMatch = normalized.match(/^(?:查询任务|查看进度|任务进度|进度)\s+([a-z0-9]+)$/iu);
  if (queryMatch) {
    return { action: "status", taskId: queryMatch[1] };
  }

  if (/^(?:查看进度|任务进度|进度|看看现在做到哪了|看看做到哪了|现在做到哪了)$/iu.test(normalized)) {
    return { action: "status" };
  }

  const stopMatch = normalized.match(/^(?:停止任务|终止任务|取消任务|停止|停掉上一条|停掉这个任务|停掉这个)\s+([a-z0-9]+)$/iu);
  if (stopMatch) {
    return { action: "stop", taskId: stopMatch[1] };
  }

  if (/^(?:停止任务|终止任务|取消任务|停止|停掉上一条|停掉这个任务|停掉这个)$/iu.test(normalized)) {
    return { action: "stop" };
  }

  const interveneMatch = normalized.match(/^(?:人工介入|转人工|人工接管|把这个转人工|暂停这个任务|暂停这个|先暂停这个任务)\s+([a-z0-9]+)$/iu);
  if (interveneMatch) {
    return { action: "intervene", taskId: interveneMatch[1] };
  }

  if (/^(?:人工介入|转人工|人工接管|把这个转人工|暂停这个任务|暂停这个|先暂停这个任务)$/iu.test(normalized)) {
    return { action: "intervene" };
  }

  const continueMatch = normalized.match(/^(?:继续任务|继续这个任务|继续上一条|重新引导这个任务|重新引导上一条|调整这个任务|按新方向继续)(?:\s+([a-z0-9]+))?(?:\s+(.+))?$/iu);
  if (continueMatch) {
    return {
      action: "continue",
      taskId: continueMatch[1] || undefined,
      followupText: continueMatch[2]?.trim() || undefined,
    };
  }

  const naturalContinueMatch = normalized.match(
    /^(?:(改用|换成|切到|改成).*(继续|续跑|重跑)?|不要文档了(?:[，,、\s]*改成直接回复)?|改成直接回复|直接回复就行|从审核阶段重新开始|从审核阶段重来|从审核重新开始|从审核重跑|按.+继续|按.+重写|重点.+继续|重新按.+)(?:\s+([a-z0-9]+))?$/iu,
  );
  if (naturalContinueMatch) {
    return {
      action: "continue",
      taskId: naturalContinueMatch[3] || undefined,
      followupText: normalized,
    };
  }

  if (/^(?:不满意|升级|换个模型|换模型|不满意升级|升级模型|用更好的模型|用更强的模型|重来一遍|不行换一个)$/iu.test(normalized)) {
    return { action: "upgrade" };
  }

  if (isDissatisfiedUpgradeRequest(normalized)) {
    return { action: "upgrade", followupText: normalized };
  }

  if (isProfessionalUpgradeRequest(normalized)) {
    return { action: "upgrade", followupText: normalized };
  }

  return null;
}

function isProfessionalUpgradeRequest(text: string): boolean {
  const normalized = text.trim();
  return /^(?:我需要|给我|请|麻烦|能否)?(?:更|再|稍微)?(?:专业|严谨|学术|论文|答辩|正式|深入|详细)(?:一点|一些)?(?:的)?(?:回答|说明|版本|表述)?$/iu.test(normalized)
    || /^(?:回答|表述|说明)(?:得)?太(?:浅|业余|口语化|泛|水)(?:了)?(?:，|,|\s)*(?:请|麻烦)?(?:更|再)?(?:专业|严谨|学术|正式|深入|详细)(?:一点|一些)?$/iu.test(normalized)
    || /^(?:请|麻烦)?(?:按|用)?(?:更)?(?:专业|严谨|学术|论文|答辩)(?:的)?(?:口吻|方式|标准)(?:重新|再)?(?:回答|说明|写一版)?$/iu.test(normalized);
}

function isDissatisfiedUpgradeRequest(text: string): boolean {
  const normalized = text.trim();
  return /^(?:我)?(?:对)?(?:还是)?不满意(?:这个|这条|上一条)?(?:回复|回答|结果)?$/iu.test(normalized)
    || /^(?:我)?(?:对)?(?:还是)?不满意(?:这个|这条|上一条)?(?:回复|回答|结果)?(?:[，,。；;\s]+.+)$/iu.test(normalized)
    || /^(?:这个|这条|上一条)(?:回复|回答|结果)(?:不行|不对|太差|太泛|太空|太水)(?:了)?$/iu.test(normalized)
    || /^(?:请|麻烦)?(?:基于上一条|基于刚才|在上一版基础上)?(?:重新|重写|重答)(?:一遍)?$/iu.test(normalized);
}

function parseAuditConfirmationReply(text: string): boolean | undefined {
  const normalized = text.trim().toLowerCase();
  if (/^(要|需要|要审核|需要审核|yes|y|review|audit)$/iu.test(normalized)) {
    return true;
  }
  if (/^(不要|不用|不需要|不审核|no|n|skip)$/iu.test(normalized)) {
    return false;
  }
  return undefined;
}

function parseAuthorizationReply(text: string): boolean {
  return /^(批准|授权|同意|继续执行|允许继续|准许继续)$/iu.test(text.trim());
}

function parseOpenFolderTarget(text: string): string | null {
  const normalized = text.trim().replace(/[。！？!?]+$/u, "");
  const match = normalized.match(/^(?:请)?(?:帮我)?(?:直接)?(?:在电脑上|在桌面上)?(?:打开|进入|切到|定位到|到)(?:一下|下)?\s*(.+?)(?:\s*(?:文件夹|目录|项目|仓库|repo))?$/iu);
  if (!match) {
    return null;
  }

  const target = match[1]?.trim();
  if (!target || /^(审核|天气|金价|进度|任务|模型)$/u.test(target)) {
    return null;
  }

  return target;
}

function inferLocalComputerActionDirective(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const fileObjectPattern = /(文件夹|目录|文件|路径|项目|仓库|repo|代码库|工作区|桌面|app\b|src\b|docs\b)/iu;
  const actionPattern = /(打开|进入|切到|定位|查看|列出|看看|搜索|查找|修改|编辑|修复|重构|运行|执行|测试)/iu;
  const explicitPathPattern = /(?:\/|\.\/|\.\.\/|~\/|`[^`]+`)/u;

  return (fileObjectPattern.test(normalized) && actionPattern.test(normalized)) || explicitPathPattern.test(normalized);
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const body = await response.text().catch(() => "");
  throw new Error(`${context}: ${response.status} ${body.slice(0, 500)}`);
}

async function resolveFolderTarget(targetLabel: string, workspaceRoot?: string): Promise<string | null> {
  const cleaned = targetLabel.replace(/[`"'“”‘’]/gu, "").trim();
  if (!cleaned) {
    return null;
  }

  const normalized = cleaned.toLowerCase();
  const hasExplicitPathSyntax = /^(?:\/|\.\/|\.\.\/|~\/)/u.test(cleaned);
  const looksLikeNestedRelativePath = cleaned.includes("/") && !/^(?:\/|~\/)/u.test(cleaned);
  const candidates: string[] = [];
  if (hasExplicitPathSyntax) {
    const expanded = cleaned.startsWith("~/") ? resolve(homedir(), cleaned.slice(2)) : resolve(workspaceRoot ?? process.cwd(), cleaned);
    candidates.push(expanded);
  }

  const home = homedir();
  const workspaceParent = workspaceRoot ? dirname(workspaceRoot) : undefined;
  if (looksLikeNestedRelativePath) {
    if (workspaceRoot) {
      candidates.push(resolve(workspaceRoot, cleaned));
    }
    if (workspaceParent) {
      candidates.push(resolve(workspaceParent, cleaned));
    }
    candidates.push(resolve(home, cleaned));
  }

  if (workspaceRoot) {
    if (basename(workspaceRoot).toLowerCase() === normalized) {
      candidates.push(workspaceRoot);
    }
    candidates.push(resolve(workspaceRoot, cleaned));
  }

  const desktopDirs = [resolve(home, "Desktop"), resolve(home, "桌面")];
  candidates.push(resolve(home, cleaned), ...desktopDirs.map((entry) => resolve(entry, cleaned)));

  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    if (await isDirectory(candidate)) {
      if (hasExplicitPathSyntax || looksLikeNestedRelativePath || basename(candidate).toLowerCase() === normalized) {
        return candidate;
      }
    }
  }

  const rootsToScan = [workspaceRoot ? resolve(workspaceRoot, "..") : undefined, workspaceRoot, home, ...desktopDirs].filter((entry): entry is string => Boolean(entry));
  const rankedMatches: Array<{ path: string; score: number }> = [];
  for (const root of rootsToScan) {
    const entries = await readdir(root).catch(() => []);
    for (const entry of entries) {
      const entryLower = entry.toLowerCase();
      const candidate = resolve(root, entry);
      if (!await isDirectory(candidate)) {
        continue;
      }

      if (entryLower === normalized) {
        rankedMatches.push({ path: candidate, score: 100 });
        continue;
      }

      if (entryLower.startsWith(normalized)) {
        rankedMatches.push({ path: candidate, score: 80 });
        continue;
      }

      if (entryLower.includes(normalized)) {
        rankedMatches.push({ path: candidate, score: 60 });
      }
    }
  }

  rankedMatches.sort((left, right) => right.score - left.score || left.path.length - right.path.length);
  return rankedMatches[0]?.path ?? null;
}

async function isDirectory(targetPath: string): Promise<boolean> {
  const fileStat = await stat(targetPath).catch(() => null);
  return Boolean(fileStat?.isDirectory());
}

async function openFolderInDesktop(targetPath: string): Promise<boolean> {
  await access(targetPath);

  return new Promise((resolvePromise) => {
    const child = spawn("xdg-open", [targetPath], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => resolvePromise(false));
    child.on("spawn", () => {
      child.unref();
      resolvePromise(true);
    });
  });
}

function formatUserFacingAnswer(answer: string, provider?: string, maxLength?: number): string {
  const withoutPromptLeakage = answer
    .split("\n")
    .filter((line) => !isLikelyPromptLeakageLine(line))
    .join("\n");

  const compact = withoutPromptLeakage
    .replace(/^Mock answer by [^:]+:\s*/i, "")
    .replace(/^Mock complex analysis by [^:]+:\s*/i, "")
    .replace(/你是本地优先办公智能体中的[^。\n]*[。.]?/gu, "")
    .replace(/请优先输出适合办公场景的简洁结论和结构化建议[。.]?/gu, "")
    .replace(/请直接输出适合办公场景的简洁结论和结构化建议[。.]?/gu, "")
    .replace(/如果发现网页登录失效、风控或人工验证，请[^。\n]*[。.]?/gu, "")
    .replace(/任务类型：.*$/gmu, "")
    .replace(/用户输入：.*$/gmu, "")
    .replace(/原问题摘要：.*$/gmu, "")
    .replace(/草稿摘要：.*$/gmu, "")
    .replace(/^要求：$/gmu, "")
    .replace(/^- .*$/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const limit = maxLength ?? (provider === "mock_provider" ? 180 : 500);
  const summary = clampFeishuText(compact, limit);
  return redactSensitiveText(summary || "任务已完成。");
}

function getWorkflow(task: TaskRecord): Record<string, unknown> {
  return ((task.sourceMeta ?? {}) as Record<string, unknown>).workflow as Record<string, unknown> ?? {};
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "已排队",
    classifying: "任务识别中",
    routing: "链路规划中",
    skill_planning: "技能装配中",
    drafting: "草稿生成中",
    reviewing: "复审中",
    audit_pending: "审核中",
    audit_revising: "按审核意见修订中",
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
  return labels[status] ?? status;
}

function getTaskTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    SIMPLE: "简单问答",
    COMPLEX: "复杂任务",
    CODING: "代码任务",
  };
  return labels[type] ?? type;
}

function getRoleLabel(role: string): string {
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
  return labels[role] ?? role;
}

function getRoleDescription(role: string): string {
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
  return descriptions[role] ?? "负责该环节执行。";
}

function getPresetLabel(preset: string): string {
  const labels: Record<string, string> = {
    standard: "标准档",
    pro: "增强档",
    expert: "专家档",
    deep: "深度档",
  };
  return labels[preset] ?? preset;
}

function formatTimeout(timeoutMs: unknown): string {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return "-";
  }
  return `${Math.round(timeoutMs / 1000)} 秒`;
}

function buildProgressBar(percent: number): string {
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(normalized / 10);
  return `[\`${"=".repeat(filled)}${"-".repeat(10 - filled)}\`] ${normalized}%`;
}

function getProgressSnapshot(task: TaskRecord): { percent: number; stage: string } {
  const mapping: Record<string, { percent: number; stage: string }> = {
    queued: { percent: 5, stage: "任务已接入" },
    classifying: { percent: 12, stage: "正在识别任务意图" },
    routing: { percent: 20, stage: "正在规划模型与角色链路" },
    skill_planning: { percent: 28, stage: "正在装配技能" },
    drafting: { percent: 42, stage: "正在生成草稿" },
    reviewing: { percent: 58, stage: "正在复审草稿" },
    audit_pending: { percent: 74, stage: "正在审核把关" },
    audit_revising: { percent: 82, stage: "正在按审核意见修订" },
    arbitrating: { percent: 88, stage: "正在仲裁定稿" },
    handoff_to_codex: { percent: 90, stage: "正在交接实现" },
    implementing: { percent: 94, stage: "正在实施" },
    testing: { percent: 97, stage: "正在测试" },
    completed: { percent: 100, stage: "任务已完成" },
    failed: { percent: 100, stage: "任务已失败" },
    needs_browser_launch: { percent: 100, stage: "等待模型窗口启动" },
    provider_session_lost: { percent: 100, stage: "模型会话失联" },
    needs_manual_login: { percent: 100, stage: "等待人工恢复登录" },
    needs_human_intervention: { percent: 100, stage: "等待人工介入" },
  };

  return mapping[task.status] ?? { percent: 0, stage: task.status };
}

function getCurrentRoleForStatus(status: string): string | null {
  if (status === "reviewing") return "hanlin_reviewer";
  if (status === "audit_pending" || status === "audit_revising") return "menxia_auditor";
  if (status === "arbitrating") return "zhongshu_arbiter";
  if (status === "handoff_to_codex" || status === "implementing" || status === "testing") return "junji_implementer";
  if (status === "completed") return null;
  return "zhongshu_drafter";
}

function buildRoleProgressLines(task: TaskRecord): string[] {
  const workflow = getWorkflow(task);
  const rolePlan = workflow.rolePlan && typeof workflow.rolePlan === "object"
    ? ((workflow.rolePlan as Record<string, unknown>).chain as Array<Record<string, unknown>> | undefined)
    : undefined;

  if (!Array.isArray(rolePlan) || rolePlan.length === 0) {
    return [];
  }

  const currentRole = getCurrentRoleForStatus(task.status);
  const currentIndex = currentRole ? rolePlan.findIndex((entry) => entry.role === currentRole) : -1;

  return rolePlan.slice(0, 7).map((entry, index) => {
    const role = typeof entry.role === "string" ? entry.role : "unknown";
    const title = typeof entry.title === "string" ? entry.title : getRoleLabel(role);
    const provider = typeof entry.provider === "string" ? entry.provider : "系统";
    const preset = typeof entry.preset === "string" ? ` · ${getPresetLabel(entry.preset)}` : "";
    const timeout = typeof entry.timeoutMs === "number" ? ` · ${formatTimeout(entry.timeoutMs)}` : "";
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

    return `**${state}** · ${title} · ${provider}${preset}${timeout}  \n${getRoleDescription(role)}`;
  });
}

function getCurrentExecutionTarget(task: TaskRecord): { role: string; provider: string; preset?: string; timeoutMs?: number } | null {
  const latestStartedStep = [...(task.steps ?? [])]
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
    .find((step) => step.status === "started");

  if (latestStartedStep) {
    const meta = latestStartedStep.meta && typeof latestStartedStep.meta === "object" ? latestStartedStep.meta : {};
    return {
      role: getCurrentRoleForStatus(task.status) ?? "crown_orchestrator",
      provider: latestStartedStep.provider ?? "系统",
      preset: typeof meta.preset === "string" ? meta.preset : undefined,
      timeoutMs: typeof meta.timeoutMs === "number" ? meta.timeoutMs : undefined,
    };
  }

  const workflow = getWorkflow(task);
  const modelPlan = workflow.modelPlan && typeof workflow.modelPlan === "object" ? (workflow.modelPlan as Record<string, unknown>) : undefined;
  const currentRole = getCurrentRoleForStatus(task.status);
  if (!currentRole || !modelPlan) {
    return null;
  }

  let target: Record<string, unknown> | undefined;
  if (currentRole === "zhongshu_drafter") {
    target = modelPlan.drafter as Record<string, unknown> | undefined;
  } else if (currentRole === "hanlin_reviewer") {
    target = Array.isArray(modelPlan.reviewers) ? (modelPlan.reviewers[0] as Record<string, unknown> | undefined) : undefined;
  } else if (currentRole === "menxia_auditor") {
    target = modelPlan.auditor as Record<string, unknown> | undefined;
  } else if (currentRole === "zhongshu_arbiter") {
    target = modelPlan.arbiter as Record<string, unknown> | undefined;
  }

  if (!target || typeof target.provider !== "string") {
    return null;
  }

  return {
    role: currentRole,
    provider: target.provider,
    preset: typeof target.preset === "string" ? target.preset : undefined,
    timeoutMs: typeof target.timeoutMs === "number" ? target.timeoutMs : undefined,
  };
}

function buildAuditFallbackLines(task: TaskRecord): string[] {
  const workflow = getWorkflow(task);
  const modelPlan = workflow.modelPlan && typeof workflow.modelPlan === "object" ? (workflow.modelPlan as Record<string, unknown>) : undefined;
  if (!modelPlan) {
    return [];
  }

  const targets: Array<Record<string, unknown>> = [];
  if (modelPlan.auditor && typeof modelPlan.auditor === "object") {
    targets.push(modelPlan.auditor as Record<string, unknown>);
  }
  if (Array.isArray(modelPlan.auditFallbacks)) {
    targets.push(...modelPlan.auditFallbacks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"));
  }

  if (targets.length === 0) {
    return [];
  }

  const chain = targets
    .map((target, index) => {
      const provider = typeof target.provider === "string" ? target.provider : "系统";
      const preset = typeof target.preset === "string" ? getPresetLabel(target.preset) : "-";
      const timeout = formatTimeout(target.timeoutMs);
      return `${index === 0 ? "主审核" : `回退 ${index}`} · ${provider} · ${preset} · ${timeout}`;
    })
    .slice(0, 5);

  const attempted = [...(task.steps ?? [])]
    .filter((step) => step.phase === "audit_pending" || step.phase === "audit_revising")
    .slice(-4)
    .map((step) => {
      const meta = step.meta && typeof step.meta === "object" ? step.meta : {};
      const preset = typeof meta.preset === "string" ? getPresetLabel(meta.preset) : "-";
      return `${step.provider ?? "系统"} · ${preset} · ${step.status === "completed" ? "通过" : step.status === "failed" ? "失败" : "进行中"}`;
    });

  return [
    `**审核链**：${chain.join(" → ")}`,
    ...(attempted.length > 0 ? [`**已尝试**：${attempted.join(" → ")}`] : []),
  ];
}

function buildProgressCard(task: TaskRecord): Record<string, unknown> {
  const workflow = getWorkflow(task);
  const progress = getProgressSnapshot(task);
  const currentTarget = getCurrentExecutionTarget(task);
  const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
  const reviewProviders = Array.isArray(task.result?.reviewOutputs)
    ? [...new Set(
        (task.result?.reviewOutputs as Array<Record<string, unknown>>)
          .map((entry) => (typeof entry.provider === "string" ? entry.provider : null))
          .filter((value): value is string => Boolean(value)),
      )]
    : [];

  return buildCard({
    title: `任务进度 · ${getStatusLabel(task.status)}`,
    template:
      task.status === "completed"
        ? "green"
        : task.status === "failed" || task.status === "needs_browser_launch" || task.status === "provider_session_lost" || task.status === "needs_manual_login" || task.status === "needs_human_intervention"
          ? "red"
          : "blue",
    lines: [
      `**任务ID**：\`${task.id}\``,
      `**类型**：${getTaskTypeLabel(task.type)}`,
      `**当前阶段**：${progress.stage}`,
      `**进度**：${buildProgressBar(progress.percent)}`,
      `**需求摘要**：${summarizeText(task.summary ?? task.userInput, 120)}`,
      ...(typeof sourceMeta.continuedFromTaskId === "string" ? [`**续跑来源**：\`${sourceMeta.continuedFromTaskId}\``] : []),
      `**任务意图**：${typeof workflow.intent === "string" ? workflow.intent : "-"}`,
      ...(typeof workflow.artifactType === "string" && workflow.artifactType !== "none" ? [`**产物类型**：${workflow.artifactType}`] : []),
      ...(typeof workflow.qualityLevel === "string" ? [`**质量等级**：${workflow.qualityLevel}`] : []),
      ...(typeof workflow.riskLevel === "string" ? [`**风险等级**：${workflow.riskLevel}`] : []),
      ...(typeof workflow.complexity === "string" ? [`**复杂度**：${workflow.complexity}`] : []),
      ...(currentTarget
        ? [
            `**当前执行**：${getRoleLabel(currentTarget.role)} · ${currentTarget.provider} · ${currentTarget.preset ? getPresetLabel(currentTarget.preset) : "-"} · ${formatTimeout(currentTarget.timeoutMs)}`,
          ]
        : []),
      ...(typeof task.result?.provider === "string" ? [`**当前产出模型**：${task.result.provider}`] : []),
      ...((reviewProviders.length > 0) ? [`**已启用复审**：${reviewProviders.join("、")}`] : []),
      ...buildAuditFallbackLines(task),
      "**任务分工**：",
      ...buildRoleProgressLines(task),
      ...buildDepartmentTraceLines(task),
      ...(task.status === "needs_human_intervention"
        ? [
            "**人工介入说明**：当前自动流程已经暂停，后续由你决定是继续调整，还是彻底终止。",
            "**你可以直接发**：`改用千问继续`、`换成专家模式继续`、`不要文档了，改成直接回复`",
            "**也可以发**：`从审核阶段重新开始`、`停掉上一条`、`看看现在做到哪了`",
          ]
        : []),
      ...(task.error ? [`**异常信息**：${summarizeText(task.error, 180)}`] : []),
    ],
  });
}

function buildAcceptedText(taskId: string, taskType: string, userText: string): string {
  void taskId;
  const normalized = userText.trim();
  const imageKind = inferImageRequestKind(normalized);
  if (imageKind) {
    if (imageKind === "avatar") {
      return "收到，这就给你做头像。";
    }
    if (imageKind === "wallpaper") {
      return "收到，这就给你做壁纸。";
    }
    if (imageKind === "poster") {
      return "收到，我先给你出一版海报。";
    }
    if (imageKind === "edit") {
      return "收到，我先按你的方向改图。";
    }
    return "收到，这就给你出图。";
  }

  const inferredIntent = inferTaskIntent({
    input: normalized,
    source: "feishu",
    sourceMeta: {},
  });

  if (inferredIntent === "image") {
    return "收到，这就给你出图。";
  }

  if (inferredIntent === "doc") {
    return "收到，我先整理成文档。";
  }

  if (inferredIntent === "ppt") {
    return "收到，我先给你排一版 PPT 结构。";
  }

  if (inferredIntent === "video") {
    return "收到，我先整理视频方案。";
  }

  if (taskType === "CODING") {
    return "收到，我先查代码和链路。";
  }

  if (taskType === "COMPLEX" || inferredIntent === "office_discussion") {
    return "收到，我先梳理一下。";
  }

  if (hasRealtimeInfoNeed(normalized)) {
    if (/(规则|公告|政策|活动|开奖|抽奖|发票|报名|截止|资格)/iu.test(normalized)) {
      return "我先查一下最新规则。";
    }
    return "我先查一下最新信息。";
  }

  return "收到，我来看看。";
}

function buildCompletionText(task: TaskRecord, answer: string, provider?: string): string {
  const summary = buildUserFacingCompletionSummary(task, answer, provider);
  return summary || formatUserFacingAnswer(answer, provider) || "已处理完成";
}

function buildFailureText(task: TaskRecord): string {
  const result = (task.result ?? {}) as Record<string, unknown>;
  if (result.authorizationPending === true) {
    return `Codex 需要授权：${summarizeText(task.error ?? "请回复“批准”继续执行。", 160)}\n回复“批准”即可继续。`;
  }

  if (task.status === "needs_human_intervention") {
    return `需要你介入：${summarizeText(task.error ?? "自动流程已暂停。", 160)}`;
  }

  return `没处理成功：${summarizeText(task.error ?? getStatusLabel(task.status), 160)}`;
}

function buildProgressText(task: TaskRecord, includeHints = false): string {
  const progress = getProgressSnapshot(task);
  const currentTarget = getCurrentExecutionTarget(task);
  const elapsedMs = Math.max(0, Date.now() - task.createdAt.getTime());
  const lead = elapsedMs >= 30_000 ? `我还在整理，当前到「${progress.stage}」` : `还在处理，当前到「${progress.stage}」`;
  const lines = [lead];

  if (currentTarget) {
    lines.push(
      `当前模型：${currentTarget.provider}${currentTarget.preset ? `（${getPresetLabel(currentTarget.preset)}）` : ""}`,
    );
  } else if (typeof task.result?.provider === "string") {
    lines.push(`当前模型：${task.result.provider}`);
  }

  if (includeHints) {
    lines.push("可发：查看进度 / 转人工 / 停掉上一条 / 换成专家模式继续 / 不满意升级");
  }

  return lines.join("\n");
}

function buildUserFacingCompletionSummary(task: TaskRecord, answer: string, provider?: string): string {
  const result = (task.result ?? {}) as Record<string, unknown>;
  const workflow = getWorkflow(task);
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  const artifactNames = artifacts
    .map((artifact) => {
      const path = typeof artifact.path === "string" ? artifact.path : "";
      return path ? basename(path) : typeof artifact.label === "string" ? artifact.label : "";
    })
    .filter((value) => value.length > 0)
    .slice(0, 4);

  const isCoding = task.type === "CODING" || workflow.intent === "coding";
  if (!isCoding) {
    const formattedAnswer = formatUserFacingAnswer(answer, provider);
    if (artifactNames.length === 0) {
      return formattedAnswer || "已处理完成";
    }
    return [`结果：已处理完成`, `产物：${artifactNames.join("、")}`, `总结：${summarizeText(formattedAnswer, 320)}`].join("\n");
  }

  const authorizationPending = result.authorizationPending === true;
  const blockedWrite = authorizationPending || detectBlockedWriteInTask(task, answer);
  const formattedAnswer = formatUserFacingAnswer(answer, provider);
  const codeFiles = extractMentionedCodeFiles(task, answer);
  const concreteCodeChanges = detectConcreteCodeChanges(task, answer);
  const explainIssueFirst = wantsIssueExplanation(task.userInput);

  if (blockedWrite) {
    const lines = ["结论：这次只完成了排查，代码还没有真正改进仓库。"];
    if (formattedAnswer) {
      lines.push(`${explainIssueFirst ? "问题" : "定位"}：${clampFeishuText(formattedAnswer, 220)}`);
    }
    if (authorizationPending) {
      lines.push("动作：回复“批准”即可继续原任务。");
    }
    return lines.join("\n");
  }

  if (concreteCodeChanges) {
    const lines = ["结论：问题已处理，代码已经完成修改。"];
    if (codeFiles.length > 0) {
      lines.push(`产物：${codeFiles.join("、")}`);
    }
    return lines.join("\n");
  }

  if (formattedAnswer) {
    const lines = [];
    if (looksLikeWriteTask(task.userInput)) {
      lines.push("结论：已完成排查，但这次没有检测到明确的代码落盘。");
    }
    lines.push(`${explainIssueFirst ? "问题" : "结论"}：${clampFeishuText(formattedAnswer, 220)}`);
    return lines.join("\n");
  }

  const lines = [
    artifactNames.length > 0
      ? "结论：任务已处理完成。"
      : "结论：任务已处理完成。",
  ];
  if (artifactNames.length > 0) {
    lines.push(`产物：${artifactNames.join("、")}`);
  }

  return lines.join("\n");
}

function detectBlockedWriteInTask(task: TaskRecord, answer: string): boolean {
  const textParts: string[] = [answer];
  const result = (task.result ?? {}) as Record<string, unknown>;
  const execution = result.codexExecution;
  if (execution && typeof execution === "object") {
    const executionRecord = execution as Record<string, unknown>;
    const stdout: string = typeof executionRecord.stdout === "string" ? executionRecord.stdout : "";
    const stderr: string = typeof executionRecord.stderr === "string" ? executionRecord.stderr : "";
    textParts.push(stdout, stderr);
  }

  const normalized = textParts
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  const markers = [
    "read-only",
    "readonly",
    "只读",
    "apply_patch",
    "permission denied",
    "eacces",
    "不能写入",
    "无法写入",
    "策略拒绝",
    "被策略拒绝",
    "尚未真正写入",
    "没法把修复真正落盘",
  ];
  return markers.some((marker) => normalized.includes(marker));
}

function detectConcreteCodeChanges(task: TaskRecord, answer: string): boolean {
  if (detectBlockedWriteInTask(task, answer)) {
    return false;
  }

  if (extractCodeArtifactFiles(task).length > 0) {
    return true;
  }

  const textParts: string[] = [answer];
  const result = (task.result ?? {}) as Record<string, unknown>;
  const execution = result.codexExecution;
  if (execution && typeof execution === "object") {
    const executionRecord = execution as Record<string, unknown>;
    textParts.push(
      typeof executionRecord.stdout === "string" ? executionRecord.stdout : "",
      typeof executionRecord.stderr === "string" ? executionRecord.stderr : "",
    );
  }

  const normalized = textParts
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!normalized) {
    return false;
  }

  const changeVerbDetected = [
    "已修改",
    "修改了",
    "更新了",
    "修复了",
    "applied patch",
    "updated",
    "modified",
    "edited",
    "changed",
    "wrote",
  ].some((marker) => normalized.includes(marker.toLowerCase()));

  return changeVerbDetected && extractMentionedCodeFiles(task, answer).length > 0;
}

function extractMentionedCodeFiles(task: TaskRecord, answer: string): string[] {
  const textParts: string[] = [answer];
  const result = (task.result ?? {}) as Record<string, unknown>;
  const execution = result.codexExecution;
  if (execution && typeof execution === "object") {
    const executionRecord = execution as Record<string, unknown>;
    textParts.push(
      typeof executionRecord.stdout === "string" ? executionRecord.stdout : "",
      typeof executionRecord.stderr === "string" ? executionRecord.stderr : "",
    );
  }

  const fileMatches = textParts
    .filter(Boolean)
    .flatMap((text) => [...text.matchAll(/(?:^|[\s`[(])((?:\/?[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|py|go|rs|java|rb|php|cs|cpp|c|h|hpp|swift|kt|sql|sh|md))(?:[:#]\d+)?/gimu)])
    .map((match) => basename(match[1] ?? ""))
    .filter((value) => value.length > 0 && !/^(?:codex_task|implementation_plan|acceptance_checklist|context_summary|implementation_brief)\.(?:md|json)$/iu.test(value));

  return [...new Set([...extractCodeArtifactFiles(task), ...fileMatches])].slice(0, 4);
}

function extractCodeArtifactFiles(task: TaskRecord): string[] {
  const result = (task.result ?? {}) as Record<string, unknown>;
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];

  return artifacts
    .map((artifact) => (typeof artifact.path === "string" ? basename(artifact.path) : ""))
    .filter((value) => /\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|py|go|rs|java|rb|php|cs|cpp|c|h|hpp|swift|kt|sql|sh)$/iu.test(value))
    .slice(0, 4);
}

function wantsIssueExplanation(input: string): boolean {
  return /(为什么|啥问题|什么问题|问题是什么|展示问题|给我看下问题|先看问题|原因是啥|原因是什么|定位问题|排查问题)/iu.test(input);
}

function looksLikeWriteTask(input: string): boolean {
  return /(修复|修一下|改一下|改下|改一改|修改|实现|重构|新增|创建|删除|重命名|写入|改代码|fix|edit|modify|implement|refactor|create|delete|rename|write)/iu.test(input);
}

function isLikelyPromptLeakageLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) {
    return false;
  }

  return (
    /layered[_\s-]?memory|episodic|semantic|task_history/iu.test(normalized)
    || /^用户问题：(?:要|不要|yes|no|y|n)$/iu.test(normalized)
    || /需要审核吗.+10\s*秒/u.test(normalized)
    || /^最近相关记忆[:：]/u.test(normalized)
    || /^记忆检索[:：]/u.test(normalized)
  );
}

function buildCurrentModelText(task: TaskRecord): string {
  const currentTarget = getCurrentExecutionTarget(task);
  if (currentTarget) {
    return [
      `当前模型：${currentTarget.provider}`,
      ...(currentTarget.preset ? [`档位：${getPresetLabel(currentTarget.preset)}`] : []),
      `当前阶段：${getStatusLabel(task.status)}`,
    ].join("\n");
  }

  if (typeof task.result?.provider === "string") {
    return [`当前模型：${task.result.provider}`, `当前阶段：${getStatusLabel(task.status)}`].join("\n");
  }

  return [`当前阶段：${getStatusLabel(task.status)}`, "当前还没有明确命中具体模型。"].join("\n");
}

function clampFeishuText(input: string, maxLength: number): string {
  const normalized = input
    .replace(/\.\.\.\[truncated \d+ chars\]/giu, "...")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildAvailableModelsText(): string {
  return [
    "当前可切换模型：doubao / qwen / deepseek / claude / gemini / gpt / grok",
    "可用说法：改用千问继续 / 换成豆包继续 / 切到 Claude 继续 / 换成专家模式继续 / 改成直接回复",
  ].join("\n");
}

function buildAcceptedCard(taskId: string, taskType: string, userText: string): Record<string, unknown> {
  return buildCard({
    title: "任务已接收",
    template: "blue",
    lines: [
      `**类型**：${getTaskTypeLabel(taskType)}`,
      `**任务ID**：\`${taskId}\``,
      `**进度**：${buildProgressBar(5)}`,
      `**你的消息**：${summarizeText(userText, 80)}`,
      "我已经开始处理，完成后会自动把结果发回来。",
    ],
  });
}

function buildCompletionCard(task: TaskRecord, answer: string, provider?: string): Record<string, unknown> {
  const answerText = buildCompletionText(task, answer, provider);
  const result = (task.result ?? {}) as Record<string, unknown>;
  const workflow = ((task.sourceMeta ?? {}) as Record<string, unknown>).workflow as Record<string, unknown> | undefined;
  const artifacts = Array.isArray(result.artifacts) ? (result.artifacts as Array<Record<string, unknown>>) : [];
  const artifactSummary = typeof result.artifactSummary === "string" ? result.artifactSummary : null;
  const providerLabel = buildProviderLabel(task, provider);

  const isSimpleChat = task.type === "SIMPLE" && (workflow?.intent === "qa" || workflow?.intent == null);
  const thoughtLines = buildThoughtProcessLines(task, providerLabel);

  if (isSimpleChat && artifacts.length === 0) {
    return buildCard({
      title: "处理结果",
      template: provider === "mock_provider" ? "orange" : "green",
      lines: [answerText],
      elements: buildThoughtProcessPanel(thoughtLines),
    });
  }

  if (workflow?.intent === "image") {
    return buildCard({
      title: "图片结果",
      template: "turquoise",
      lines: [
        `**本次模型**：${providerLabel}`,
        `**结果摘要**：${formatUserFacingAnswer(answer, provider)}`,
        ...(artifactSummary ? [`**交付摘要**：${summarizeText(artifactSummary, 180)}`] : []),
        ...artifacts.slice(0, 4).map((artifact) => {
          const label = typeof artifact.label === "string" ? artifact.label : "artifact";
          const path = typeof artifact.path === "string" ? artifact.path : "-";
          return `**产物**：${label}  \n\`${path}\``;
        }),
        "如果这版风格不满意，可以直接补充修改要求继续出图。",
      ],
      elements: buildThoughtProcessPanel(thoughtLines),
    });
  }

  if (workflow?.intent === "video") {
    return buildCard({
      title: "视频结果",
      template: "wathet",
      lines: [
        `**本次模型**：${providerLabel}`,
        `**结果摘要**：${formatUserFacingAnswer(answer, provider)}`,
        ...(artifactSummary ? [`**交付摘要**：${summarizeText(artifactSummary, 180)}`] : []),
        ...artifacts.slice(0, 5).map((artifact) => {
          const label = typeof artifact.label === "string" ? artifact.label : "artifact";
          const path = typeof artifact.path === "string" ? artifact.path : "-";
          return `**产物**：${label}  \n\`${path}\``;
        }),
      ],
      elements: buildThoughtProcessPanel(thoughtLines),
    });
  }

  if (workflow?.intent === "doc") {
    const documentArtifacts = artifacts
      .map((artifact) => {
        const label = typeof artifact.label === "string" ? artifact.label : "artifact";
        const path = typeof artifact.path === "string" ? artifact.path : "";
        return path ? `${label} · ${basename(path)}` : label;
      })
      .slice(0, 4);

    return buildCard({
      title: "文档结果",
      template: "green",
      lines: [
        summarizeDocResult(formatUserFacingAnswer(answer, provider), task.summary ?? task.userInput),
        ...(documentArtifacts.length > 0 ? [`**产物**：${documentArtifacts.join("、")}`] : []),
      ],
      elements: buildThoughtProcessPanel(thoughtLines),
    });
  }

  return buildCard({
    title:
      provider === "mock_provider"
        ? "处理结果 · 演示模式"
        : provider === "local_fastlane"
          ? "处理结果"
          : "处理结果",
    template: provider === "mock_provider" ? "orange" : "green",
    lines: [
      answerText,
      ...(artifactSummary ? [`**产物摘要**：${summarizeText(artifactSummary, 180)}`] : []),
      ...artifacts.slice(0, 4).map((artifact) => {
        const label = typeof artifact.label === "string" ? artifact.label : "artifact";
        const path = typeof artifact.path === "string" ? artifact.path : "-";
        return `**产物**：${label}  \n\`${path}\``;
      }),
    ],
    elements: buildThoughtProcessPanel(thoughtLines),
  });
}

function buildThoughtProcessLines(task: TaskRecord, providerLabel?: string): string[] {
  if (!shouldIncludeThoughtProcess(task)) {
    return [];
  }

  return buildDetailedThoughtProcessLines(task, providerLabel);
}

function shouldIncludeThoughtProcess(task: TaskRecord): boolean {
  const workflow = getWorkflow(task);
  const result = (task.result ?? {}) as Record<string, unknown>;
  const reviewOutputs = Array.isArray(result.reviewOutputs) ? result.reviewOutputs.length : 0;
  const candidatePlans = Array.isArray(result.candidatePlans) ? result.candidatePlans.length : 0;
  const hasAudit = Boolean(result.audit && typeof result.audit === "object");
  const hasCodexExecution = Boolean(result.codexExecution && typeof result.codexExecution === "object");
  const hasFailures = Array.isArray(result.failures) && result.failures.length > 0;
  const multiStep = (task.steps?.length ?? 0) > 1;

  return (
    task.type !== "SIMPLE"
    || workflow.tier === "T3"
    || workflow.intent === "office_discussion"
    || workflow.qualityLevel === "high"
    || workflow.qualityLevel === "strict"
    || workflow.riskLevel === "medium"
    || workflow.riskLevel === "high"
    || workflow.riskLevel === "critical"
    || workflow.complexity === "hard"
    || reviewOutputs > 0
    || candidatePlans > 1
    || hasAudit
    || hasCodexExecution
    || hasFailures
    || multiStep
  );
}

function buildDetailedThoughtProcessLines(task: TaskRecord, providerLabel?: string): string[] {
  const workflow = getWorkflow(task);
  const tierLabel = workflow.tier ? `T${workflow.tier.toString().replace("T", "")}` : "";
  const tierDesc: Record<string, string> = {
    T0: "本地快捷回复",
    T1: "API快速通道",
    T2: "单模型处理",
    T3: "多模型协同",
  };
  const result = (task.result ?? {}) as Record<string, unknown>;
  const lines = [
    `**问题**：${summarizeText(task.summary ?? task.userInput, 120)}`,
    `**类型**：${getTaskTypeLabel(task.type)}`,
    ...(tierLabel ? [`**层级**：${tierLabel}（${tierDesc[tierLabel] ?? ""}）`] : []),
    `**结果**：${getStatusLabel(task.status)}`,
    ...(providerLabel ? [`**模型**：${providerLabel}`] : []),
  ];

  const plannedChain = buildPlannedExecutionChain(task);
  if (plannedChain) {
    lines.push(`**链路规划**：${plannedChain}`);
  }

  const actualChain = buildActualExecutionChain(task);
  if (actualChain) {
    lines.push(`**实际执行**：${actualChain}`);
  }

  const codeFiles = extractMentionedCodeFiles(task, typeof task.result?.answer === "string" ? task.result.answer : "");
  if (codeFiles.length > 0) {
    lines.push(`**涉及文件**：${codeFiles.join("、")}`);
  }

  const draftOutput = result.draftOutput && typeof result.draftOutput === "object"
    ? (result.draftOutput as Record<string, unknown>)
    : null;
  if (draftOutput) {
    const provider = typeof draftOutput.provider === "string" ? draftOutput.provider : "draft";
    const text = typeof draftOutput.text === "string" ? draftOutput.text : typeof draftOutput.summary === "string" ? draftOutput.summary : "";
    if (text) {
      lines.push(`**草稿过程 · ${provider}**：${clampFeishuText(text, 900)}`);
    }
  }

  const reviewOutputs = Array.isArray(result.reviewOutputs)
    ? result.reviewOutputs.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  for (const entry of reviewOutputs.slice(0, 4)) {
    const reviewProvider = typeof entry.provider === "string" ? entry.provider : "review";
    const reviewText = typeof entry.text === "string" ? entry.text : "";
    if (reviewText) {
      lines.push(`**复审过程 · ${reviewProvider}**：${clampFeishuText(reviewText, 900)}`);
    }
  }

  const audit = result.audit && typeof result.audit === "object"
    ? (result.audit as Record<string, unknown>)
    : null;
  if (audit) {
    const decision = typeof audit.decision === "string" ? getAuditDecisionLabel(audit.decision) : "已审核";
    const rawText = typeof audit.rawText === "string" ? audit.rawText : "";
    const issues = Array.isArray(audit.issues)
      ? audit.issues.filter((item): item is string => typeof item === "string").join("；")
      : "";
    const suggestions = Array.isArray(audit.suggestions)
      ? audit.suggestions.filter((item): item is string => typeof item === "string").join("；")
      : "";
    const auditDetail = rawText || [issues, suggestions].filter(Boolean).join("；");
    if (auditDetail) {
      lines.push(`**审核过程 · ${decision}**：${clampFeishuText(auditDetail, 900)}`);
    }
  }

  const candidatePlans = Array.isArray(result.candidatePlans)
    ? result.candidatePlans.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  for (const entry of candidatePlans.slice(0, 4)) {
    const planProvider = typeof entry.provider === "string" ? entry.provider : "plan";
    const planText = typeof entry.plan === "string" ? entry.plan : "";
    if (planText) {
      lines.push(`**方案讨论 · ${planProvider}**：${clampFeishuText(planText, 900)}`);
    }
  }

  if (typeof result.finalPlan === "string" && result.finalPlan.trim()) {
    lines.push(`**最终方案**：${clampFeishuText(result.finalPlan, 900)}`);
  }

  const execution = result.codexExecution && typeof result.codexExecution === "object"
    ? (result.codexExecution as Record<string, unknown>)
    : null;
  if (execution) {
    const stdout = typeof execution.stdout === "string" ? execution.stdout : "";
    const stderr = typeof execution.stderr === "string" ? execution.stderr : "";
    const combined = [stdout, stderr].filter(Boolean).join("\n");
    if (combined) {
      lines.push(`**实施记录**：${clampFeishuText(combined, 900)}`);
    }
  }

  const failures = Array.isArray(result.failures)
    ? result.failures.filter((item): item is string => typeof item === "string").slice(0, 4)
    : [];
  if (failures.length > 0) {
    lines.push(`**失败与回退**：${clampFeishuText(failures.join(" | "), 900)}`);
  }

  const processLines = buildDepartmentTraceLines(task)
    .filter((line) => !/^(\*\*舞桥执行摘要\*\*：?|舞桥执行摘要：?)$/u.test(line.trim()))
    .slice(0, 6);

  return [...lines, ...processLines].slice(0, 18);
}

function buildPlannedExecutionChain(task: TaskRecord): string {
  const workflow = getWorkflow(task);
  const modelPlan = workflow.modelPlan && typeof workflow.modelPlan === "object" ? (workflow.modelPlan as Record<string, unknown>) : null;
  if (!modelPlan) {
    return "";
  }

  const targets: Array<Record<string, unknown>> = [];
  if (modelPlan.drafter && typeof modelPlan.drafter === "object") {
    targets.push(modelPlan.drafter as Record<string, unknown>);
  }
  if (Array.isArray(modelPlan.reviewers)) {
    targets.push(...modelPlan.reviewers.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").slice(0, 4));
  }
  if (modelPlan.auditor && typeof modelPlan.auditor === "object") {
    targets.push(modelPlan.auditor as Record<string, unknown>);
  }
  if (modelPlan.arbiter && typeof modelPlan.arbiter === "object") {
    targets.push(modelPlan.arbiter as Record<string, unknown>);
  }

  return targets
    .map((target) => {
      const provider = typeof target.provider === "string" ? target.provider : "系统";
      const preset = typeof target.preset === "string" ? `/${getPresetLabel(target.preset)}` : "";
      return `${provider}${preset}`;
    })
    .join(" → ");
}

function buildActualExecutionChain(task: TaskRecord): string {
  const steps = [...(task.steps ?? [])]
    .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
    .slice(0, 12);

  return steps
    .map((step) => {
      const meta = step.meta && typeof step.meta === "object" ? step.meta : {};
      const preset = typeof meta.preset === "string" ? `/${getPresetLabel(meta.preset)}` : "";
      const provider = step.provider ?? "系统";
      return `${provider}${preset} · ${getStatusLabel(step.phase)} · ${getStepStatusLabel(step.status)}`;
    })
    .join(" → ");
}

function getStepStatusLabel(status: string): string {
  if (status === "completed") {
    return "完成";
  }
  if (status === "failed") {
    return "失败";
  }
  return "进行中";
}

function buildProviderLabel(task: TaskRecord, provider?: string): string {
  if (provider === "mock_provider") {
    return "演示回复";
  }
  if (provider === "local_fastlane") {
    return "本地快速回复";
  }

  const providerMeta =
    task.result?.providerMeta && typeof task.result.providerMeta === "object"
      ? (task.result.providerMeta as Record<string, unknown>)
      : null;
  const model = providerMeta && typeof providerMeta.model === "string" ? providerMeta.model : "";
  if (provider && model) {
    return `${provider} · ${model}`;
  }
  return provider ?? "unknown";
}

function buildThoughtProcessPanel(lines: string[]): Array<Record<string, unknown>> {
  if (lines.length === 0) {
    return [];
  }

  return [
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: {
          tag: "plain_text",
          content: "执行链路与过程",
        },
        padding: "6px 0px 6px 0px",
        icon_position: "right",
        icon_expanded_angle: 90,
      },
      elements: lines.map((line) => ({
        tag: "markdown",
        content: redactSensitiveText(line),
      })),
    },
  ];
}

function summarizeDocResult(answerText: string, fallbackInput: string): string {
  const compact = answerText
    .replace(/【[^】]+】/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const summary = summarizeText(compact, 140);
  if (summary && summary !== "-") {
    return summary;
  }
  return `已根据“${summarizeText(fallbackInput, 36)}”生成文档初稿和提纲。`;
}

function buildDepartmentTraceLines(task: TaskRecord): string[] {
  const result = (task.result ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const draftOutput = result.draftOutput && typeof result.draftOutput === "object"
    ? (result.draftOutput as Record<string, unknown>)
    : null;
  const reviewOutputs = Array.isArray(result.reviewOutputs)
    ? result.reviewOutputs.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  const audit = result.audit && typeof result.audit === "object"
    ? (result.audit as Record<string, unknown>)
    : null;
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];

  if (draftOutput && typeof draftOutput.provider === "string") {
    const summary =
      typeof draftOutput.summary === "string" && draftOutput.summary.trim()
        ? draftOutput.summary
        : typeof draftOutput.text === "string"
          ? draftOutput.text
          : "";
    if (summary) {
      lines.push(`**首席科学官**：${summarizeText(summary, 110)}`);
    }
  }

  if (reviewOutputs.length > 0) {
    const merged = reviewOutputs
      .map((entry) => {
        const provider = typeof entry.provider === "string" ? entry.provider : "reviewer";
        const text = typeof entry.text === "string" ? summarizeText(entry.text, 80) : "";
        return text ? `${provider}：${text}` : provider;
      })
      .join("；");
    if (merged) {
      lines.push(`**大副**：${summarizeText(merged, 120)}`);
    }
  }

  if (audit) {
    const decision = typeof audit.decision === "string" ? getAuditDecisionLabel(audit.decision) : "已审核";
    const issues = Array.isArray(audit.issues)
      ? audit.issues.filter((item): item is string => typeof item === "string").slice(0, 2).join("；")
      : "";
    const suggestions = Array.isArray(audit.suggestions)
      ? audit.suggestions.filter((item): item is string => typeof item === "string").slice(0, 2).join("；")
      : "";
    const detail = [issues, suggestions].filter(Boolean).join("；");
    lines.push(`**安全官**：${decision}${detail ? ` · ${summarizeText(detail, 120)}` : ""}`);
  }

  if (artifacts.length > 0) {
    const names = artifacts
      .map((artifact) => {
        const path = typeof artifact.path === "string" ? basename(artifact.path) : "";
        return path || (typeof artifact.label === "string" ? artifact.label : "artifact");
      })
      .slice(0, 4)
      .join("、");
    lines.push(`**轮机长**：已整理交付物 ${names}。`);
  }

  if (lines.length > 0) {
    return ["舞桥执行摘要：", ...lines];
  }

  return [];
}

function getAuditDecisionLabel(decision: string): string {
  const labels: Record<string, string> = {
    pass: "审核通过",
    revise_required: "要求修订",
    reject: "审核驳回",
  };
  return labels[decision] ?? decision;
}

function buildFailureCard(task: TaskRecord): Record<string, unknown> {
  return buildCard({
    title: "任务失败",
    template: "red",
    lines: [
      buildFailureText(task),
    ],
    elements: buildThoughtProcessPanel([
      `**问题理解**：${summarizeText(task.summary ?? task.userInput, 120)}`,
      `**当前状态**：${getStatusLabel(task.status)}`,
      ...(typeof task.result?.provider === "string" ? [`**本次模型**：${task.result.provider}`] : []),
      ...(task.error ? [`**异常信息**：${summarizeText(task.error, 180)}`] : []),
      ...buildRoleProgressLines(task).slice(0, 4),
    ]),
  });
}

function buildStatusCard(task: TaskRecord): Record<string, unknown> {
  const currentTarget = getCurrentExecutionTarget(task);
  return buildCard({
    title: "任务状态",
    template: task.status === "completed" ? "green" : task.status === "failed" ? "red" : "blue",
    lines: [
      `**任务ID**：\`${task.id}\``,
      `**类型**：${getTaskTypeLabel(task.type)}`,
      `**状态**：${getStatusLabel(task.status)}`,
      `**进度**：${buildProgressBar(getProgressSnapshot(task).percent)}`,
      `**摘要**：${task.summary ?? "-"}`,
      ...(currentTarget
        ? [
            `**当前执行**：${getRoleLabel(currentTarget.role)} · ${currentTarget.provider} · ${currentTarget.preset ? getPresetLabel(currentTarget.preset) : "-"} · ${formatTimeout(currentTarget.timeoutMs)}`,
          ]
        : []),
      `**结果**：${summarizeText(task.outputSummary ?? "-", 180)}`,
      ...buildAuditFallbackLines(task),
      ...buildRoleProgressLines(task).length > 0 ? ["**任务分工**：", ...buildRoleProgressLines(task)] : [],
    ],
  });
}

function buildCard(input: { title: string; template: string; lines: string[]; elements?: Array<Record<string, unknown>> }): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: input.template,
      title: {
        tag: "plain_text",
        content: input.title,
      },
    },
    elements: [
      ...input.lines.map((line) => ({
        tag: "markdown",
        content: redactSensitiveText(line),
      })),
      ...(input.elements ?? []),
    ],
  };
}

function extractImageArtifacts(task: TaskRecord): Array<{ label: string; path: string }> {
  const artifacts = Array.isArray(task.result?.artifacts) ? (task.result?.artifacts as Array<Record<string, unknown>>) : [];
  return artifacts.flatMap((artifact) => {
    const label = typeof artifact.label === "string" ? artifact.label : "artifact";
    const path = typeof artifact.path === "string" ? artifact.path : "";
    if (!path || !/\.(png|jpe?g|webp|gif|bmp|tiff)$/iu.test(path)) {
      return [];
    }

    return [{ label, path }];
  });
}

function extractDocumentArtifacts(task: TaskRecord): Array<{ label: string; path: string }> {
  const artifacts = Array.isArray(task.result?.artifacts) ? (task.result?.artifacts as Array<Record<string, unknown>>) : [];
  return artifacts.flatMap((artifact) => {
    const label = typeof artifact.label === "string" ? artifact.label : "artifact";
    const path = typeof artifact.path === "string" ? artifact.path : "";
    if (!path || !/\.(docx?|md)$/iu.test(path)) {
      return [];
    }

    return [{ label, path }];
  });
}

function buildFriendlyImageText(imageCount: number, answer: string): string {
  if (imageCount > 0) {
    return `给你出好了 ${imageCount} 张图，先看看。不满意的话直接告诉我想改哪里，我接着调。`;
  }

  const summary = formatUserFacingAnswer(answer);
  return summary || "这次没顺利拿到图片，你可以再发一次，我继续帮你盯。";
}

function buildGenericImageText(imageCount: number, answer: string, provider?: string): string {
  const summary = formatUserFacingAnswer(answer, provider);
  if (imageCount > 0) {
    return summary || `已经回传 ${imageCount} 张图片。`;
  }

  return summary || "图片结果已经处理完成。";
}

function buildContinuationMeta(task: TaskRecord, followupText?: string): Record<string, unknown> {
  const result = (task.result ?? {}) as Record<string, unknown>;
  const draftOutput =
    result.draftOutput && typeof result.draftOutput === "object"
      ? sanitizeRecord(result.draftOutput as Record<string, unknown>)
      : undefined;
  const reviewOutputs = Array.isArray(result.reviewOutputs)
    ? result.reviewOutputs
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => sanitizeRecord(entry))
        .slice(0, 6)
    : undefined;
  const continuation: Record<string, unknown> = {
    fromTaskId: task.id,
    fromStatus: task.status,
    followupText,
    previousAnswer: typeof result.answer === "string" ? result.answer : task.outputSummary ?? undefined,
    previousProvider: typeof result.provider === "string" ? result.provider : undefined,
    previousProviderMeta:
      result.providerMeta && typeof result.providerMeta === "object"
        ? sanitizeRecord(result.providerMeta as Record<string, unknown>)
        : undefined,
    previousDraftOutput: draftOutput,
    previousReviewOutputs: reviewOutputs,
    previousFailures: Array.isArray(result.failures)
      ? result.failures.filter((item): item is string => typeof item === "string").slice(0, 8)
      : undefined,
    localContextSummary:
      result.localContext && typeof result.localContext === "object" && typeof (result.localContext as Record<string, unknown>).summary === "string"
        ? (result.localContext as Record<string, unknown>).summary
        : undefined,
  };

  const restartPhase = inferRestartPhaseDirective(followupText ?? "");
  if (restartPhase) {
    continuation.restartPhase = restartPhase;
  }

  return sanitizeRecord(continuation);
}

function buildContinuationInput(task: TaskRecord, followupText: string | undefined, mode: "continue" | "upgrade"): string {
  const result = (task.result ?? {}) as Record<string, unknown>;
  const previousAnswer = typeof result.answer === "string" ? result.answer : task.outputSummary ?? "";
  const segments = [`原始问题：${task.userInput}`];

  if (previousAnswer.trim()) {
    segments.push(`上一版回答：${summarizeText(previousAnswer, 1200)}`);
  }

  if (followupText?.trim()) {
    segments.push(`${mode === "upgrade" ? "补充要求" : "继续要求"}：${followupText.trim()}`);
  }

  if (mode === "upgrade") {
    segments.push("请保留同一问题的上下文，不要要求用户重复描述主题；直接给出更专业、更严谨、术语更准确的新版回答。");
  }

  return segments.join("\n\n");
}

function upgradeQualityLevel(
  current: TaskQualityLevel | undefined,
  followupText?: string,
): TaskQualityLevel {
  const normalized = followupText ?? "";
  if (/(论文|答辩|学术|严谨|正式)/iu.test(normalized)) {
    return "strict";
  }
  if (current === "strict") {
    return current;
  }
  return "high";
}

function upgradePresetHint(
  current: ModelPresetName | undefined,
  followupText?: string,
): ModelPresetName {
  if (current === "deep" || current === "expert") {
    return current;
  }
  const normalized = followupText ?? "";
  if (/(论文|答辩|学术|深入分析|深度分析)/iu.test(normalized)) {
    return "expert";
  }
  return current === "pro" ? current : "pro";
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function buildImageUploadFailureText(errorMessage: string | undefined, imageCount: number): string {
  const detail = summarizeText(errorMessage ?? "", 160);
  if (detail.includes("99991672") || detail.includes("im:resource:upload") || detail.includes("im:resource")) {
    return `图其实已经生成好了，一共 ${imageCount} 张，但飞书机器人现在没开通图片上传权限（im:resource:upload / im:resource），所以这次发不出图片。权限开通后我就能直接把图回给你。`;
  }

  return `图其实已经生成好了，一共 ${imageCount} 张，但回传到飞书这一步失败了：${detail || "上传图片失败"}。`;
}

function isFeishuImageTooLargeError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return normalized.includes("234006") || normalized.includes("file size exceed the max value");
}

async function createOptimizedFeishuImage(filePath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tempDir = resolve("/tmp", "office-agent-feishu");
  await mkdir(tempDir, { recursive: true });
  const outputPath = resolve(tempDir, `${Date.now()}-${basename(filePath).replace(/\.[^.]+$/u, "")}.jpg`);
  await runPythonImageOptimize(filePath, outputPath);
  return {
    path: outputPath,
    cleanup: async () => {
      await rm(outputPath, { force: true });
    },
  };
}

async function runPythonImageOptimize(inputPath: string, outputPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "python3",
      [
        "-c",
        [
          "from PIL import Image, ImageOps",
          "import os, sys",
          "src, dst = sys.argv[1], sys.argv[2]",
          "img = Image.open(src)",
          "img = ImageOps.exif_transpose(img)",
          "if img.mode not in ('RGB', 'L'):",
          "    img = img.convert('RGB')",
          "attempts = [(2560, 82), (2048, 76), (1600, 70), (1280, 64)]",
          "for max_edge, quality in attempts:",
          "    working = img.copy()",
          "    width, height = working.size",
          "    scale = min(1.0, max_edge / float(max(width, height)))",
          "    if scale < 1.0:",
          "        working = working.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.LANCZOS)",
          "    working.save(dst, format='JPEG', quality=quality, optimize=True, progressive=True)",
          "    if os.path.getsize(dst) <= 9 * 1024 * 1024:",
          "        break",
        ].join("\n"),
        inputPath,
        outputPath,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(stderr.trim() || `python3 optimize exited with code ${code}`));
    });
  });
}

function buildDocumentUploadFailureText(errorMessage: string | undefined, filePath: string): string {
  const detail = summarizeText(errorMessage ?? "", 160);
  if (detail.includes("99991672") || detail.includes("im:resource:upload") || detail.includes("im:resource")) {
    return `Word 文档已经生成好了，文件名是 ${basename(filePath)}，但飞书机器人现在没开通文件上传权限，所以这次还发不出来。权限开通后我就能直接把文档回给你。`;
  }

  return `Word 文档已经生成好了，文件名是 ${basename(filePath)}，但回传到飞书失败了：${detail || "上传文件失败"}。`;
}

function inferImageRequestKind(text: string): "generate" | "edit" | "avatar" | "wallpaper" | "poster" | undefined {
  const normalized = text.trim().toLowerCase();

  if (/(头像|头像图|微信头像|群头像|profile picture|profile photo)/iu.test(normalized)) {
    return "avatar";
  }

  if (/(壁纸|桌面|手机壁纸|电脑壁纸|锁屏|屏保)/iu.test(normalized)) {
    return "wallpaper";
  }

  if (/(海报|封面|封面图|配图|宣传图|banner|横幅)/iu.test(normalized)) {
    return "poster";
  }

  if (/(改图|重绘|重画|重做一版|二创|换风格|修图|精修|抠图|改成.+风|改一下这张图|把这张图改成)/iu.test(normalized)) {
    return "edit";
  }

  if (/(画一张|来一张|做一张|生成|出图|给我一张|帮我画|帮我做|帮我生成)/iu.test(normalized)) {
    return "generate";
  }

  return undefined;
}

export function buildFeishuSubmission(
  text: string,
  sourceMeta: Record<string, unknown>,
  options?: {
    auditPreference?: boolean;
  },
): FeishuSubmissionDraft {
  const directives = parseFeishuDirectives(text);
  const routeOverrides = mergeRouteOverrides(
    inferRealtimeRouteOverrides(directives.cleanInput),
    mergeRouteOverrides(inferRouteOverrides(directives.cleanInput), directives.routeOverrides),
  );
  const continuation = mergeRouteOverrides(
    sourceMeta.continuation && typeof sourceMeta.continuation === "object"
      ? (sourceMeta.continuation as Record<string, unknown>)
      : undefined,
    directives.continuation,
  );
  const imageRequestKind = inferImageRequestKind(directives.cleanInput);
  const mergedSourceMeta = {
    ...sourceMeta,
    ...(imageRequestKind ? { imageRequestKind } : {}),
    ...(routeOverrides ? { routeOverrides } : {}),
    ...(continuation ? { continuation } : {}),
  };
  const baseSubmission: TaskSubmission = {
    input: directives.cleanInput,
    requestedType: directives.requestedType,
    requestedIntent: directives.requestedIntent,
    artifactType: directives.artifactType,
    source: "feishu",
    sourceMeta: mergedSourceMeta,
    qualityLevel: directives.qualityLevel,
    riskLevel: directives.riskLevel,
    complexity: directives.complexity,
    presetHints: directives.presetHints,
    executionPolicy: directives.executionPolicy,
  };
  const requestedIntent = inferTaskIntent(baseSubmission);
  const artifactType = inferArtifactType({
    ...baseSubmission,
    requestedIntent,
  });
  const audit = inferAuditPolicy({
    ...baseSubmission,
    requestedIntent,
    artifactType,
  });

  return {
    input: directives.cleanInput,
    requestedType: imageRequestKind ? (directives.requestedType ?? "COMPLEX") : directives.requestedType,
    sourceMeta: mergedSourceMeta,
    requestedIntent: imageRequestKind ? "image" : requestedIntent,
    artifactType: imageRequestKind ? "image" : artifactType === "none" ? undefined : artifactType,
    requiresAudit: options?.auditPreference ?? directives.requiresAudit ?? audit.requested ?? undefined,
    qualityLevel: directives.qualityLevel,
    riskLevel: directives.riskLevel,
    complexity: directives.complexity,
    presetHints: hasRealtimeInfoNeed(directives.cleanInput)
      ? {
          preferredReasoning: directives.presetHints?.preferredReasoning ?? "pro",
          ...directives.presetHints,
        }
      : directives.presetHints,
    executionPolicy: hasRealtimeInfoNeed(directives.cleanInput)
      ? {
          allowProviderFallback: true,
          ...directives.executionPolicy,
        }
      : directives.executionPolicy,
  };
}

function parseFeishuDirectives(text: string): {
  cleanInput: string;
  requestedType?: TaskType;
  requestedIntent?: TaskSubmission["requestedIntent"];
  artifactType?: TaskSubmission["artifactType"];
  routeOverrides?: Record<string, unknown>;
  qualityLevel?: TaskQualityLevel;
  riskLevel?: TaskRiskLevel;
  complexity?: TaskComplexity;
  requiresAudit?: boolean;
  presetHints?: TaskSubmission["presetHints"];
  executionPolicy?: TaskSubmission["executionPolicy"];
  continuation?: Record<string, unknown>;
} {
  let cleanInput = text;
  const consume = (pattern: RegExp): string | undefined => {
    let captured: string | undefined;
    cleanInput = cleanInput.replace(pattern, (_match, value: string) => {
      captured = value.trim();
      return " ";
    });
    return captured;
  };

  const providerRaw = consume(/(?:^|\s)[#【\[]?(?:模型|provider)\s*[:=：]\s*([a-z0-9_\-\u4e00-\u9fa5]+)[】\]]?/giu);
  const presetRaw = consume(/(?:^|\s)[#【\[]?(?:档位|模式|preset)\s*[:=：]\s*([a-z0-9_\-\u4e00-\u9fa5]+)[】\]]?/giu);
  const qualityRaw = consume(/(?:^|\s)[#【\[]?质量(?:等级)?\s*[:=：]\s*([a-z0-9_\-\u4e00-\u9fa5]+)[】\]]?/giu);
  const riskRaw = consume(/(?:^|\s)[#【\[]?风险(?:等级)?\s*[:=：]\s*([a-z0-9_\-\u4e00-\u9fa5]+)[】\]]?/giu);
  const complexityRaw = consume(/(?:^|\s)[#【\[]?(?:复杂度|难度)\s*[:=：]\s*([a-z0-9_\-\u4e00-\u9fa5]+)[】\]]?/giu);
  const auditRaw = consume(/(?:^|\s)[#【\[]?(?:审核|复核)\s*[:=：]\s*(是|否|需要|不用|true|false|yes|no)[】\]]?/giu);

  cleanInput = cleanInput.replace(/\s{2,}/g, " ").trim() || text;

  const directCliRunner = inferCodingCliDirective(text);
  const localComputerActionRequested = inferLocalComputerActionDirective(text);
  const collaborativeCodexRequested = inferCollaborativeCodexDiscussionDirective(text);
  const directCodexFixRequested = inferDirectCodexFixDirective(text);
  const provider = directCliRunner ? undefined : normalizeProviderDirective(providerRaw) ?? inferNaturalProviderDirective(text);
  const preset = normalizePresetDirective(presetRaw) ?? inferNaturalPresetDirective(text);
  const directReplyRequested = inferDirectReplyDirective(text);
  const directCliRequested = Boolean((directCliRunner || localComputerActionRequested || directCodexFixRequested) && !collaborativeCodexRequested);
  const restartPhase = inferRestartPhaseDirective(text);
  const resolvedCliRunner = directCliRunner ?? ((localComputerActionRequested || directCodexFixRequested) ? "codex" : undefined);
  const codingWorkflowRequested = directCliRequested || collaborativeCodexRequested;

  return {
    cleanInput,
    requestedType: directReplyRequested ? "SIMPLE" : codingWorkflowRequested ? "CODING" : undefined,
    requestedIntent: directReplyRequested ? "qa" : codingWorkflowRequested ? "coding" : undefined,
    artifactType: directReplyRequested ? "none" : undefined,
    routeOverrides:
      provider || directCliRequested || collaborativeCodexRequested
        ? {
            ...(provider
              ? {
                  draftProvider: provider,
                  finalArbiter: provider,
                  reviewers: [provider],
                }
              : {}),
            ...(directCliRequested ? { autoRunCodex: true, directToCodex: true, directCliRunner: resolvedCliRunner } : {}),
            ...(collaborativeCodexRequested ? { autoRunCodex: true } : {}),
          }
        : undefined,
    qualityLevel: normalizeQualityDirective(qualityRaw),
    riskLevel: normalizeRiskDirective(riskRaw),
    complexity: normalizeComplexityDirective(complexityRaw),
    requiresAudit: normalizeAuditDirective(auditRaw),
    presetHints: preset
      ? {
          preferredReasoning: preset,
        }
      : undefined,
    executionPolicy: provider || preset || collaborativeCodexRequested
      ? {
          ...(provider ? { forceProvider: provider } : {}),
          ...(preset ? { forcePreset: preset } : {}),
          ...(collaborativeCodexRequested ? { discussionMode: "all_advanced" as const } : {}),
        }
      : undefined,
    continuation: restartPhase ? { restartPhase } : undefined,
  };
}

function mergeRouteOverrides(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function normalizeProviderDirective(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  const aliases: Array<[RegExp, string]> = [
    [/(claude|克劳德)/u, "claude_web"],
    [/(qwen|千问|通义)/u, "qwen_web"],
    [/(grok)/u, "grok_web"],
    [/(doubao|豆包)/u, "doubao_web"],
    [/(deepseek|深度求索)/u, "deepseek_web"],
    [/(gemini|谷歌)/u, "gemini_web"],
    [/(gpt|chatgpt)/u, "chatgpt_web"],
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1];
}

function normalizePresetDirective(value?: string): ModelPresetName | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/(standard|标准|默认|auto)/u.test(normalized)) return "standard";
  if (/(pro|增强|进阶)/u.test(normalized)) return "pro";
  if (/(expert|专家)/u.test(normalized)) return "expert";
  if (/(deep|深度|思考)/u.test(normalized)) return "deep";
  return undefined;
}

function inferNaturalProviderDirective(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (!/(用|换成|改用|切到|走|指定)/u.test(normalized)) {
    return undefined;
  }
  return normalizeProviderDirective(normalized);
}

function inferNaturalPresetDirective(text: string): ModelPresetName | undefined {
  const normalized = text.toLowerCase();
  if (/(自动模式|auto模式|默认模式)/u.test(normalized)) return "standard";
  if (/(标准模式|普通模式|简单模式|快速模式)/u.test(normalized)) return "standard";
  if (/(增强模式|高级模式|进阶模式)/u.test(normalized)) return "pro";
  if (/(专业回答|专业版|严谨版|学术版|论文级|答辩级|答辩口吻)/u.test(normalized)) return "expert";
  if (/(专家模式|专家审核)/u.test(normalized)) return "expert";
  if (/(深度思考|深度分析|深入思考)/u.test(normalized)) return "deep";
  return undefined;
}

function inferDirectReplyDirective(text: string): boolean {
  return /(不要文档了|改成直接回复|直接回复就行|不要word|不要docx|不用文档)/iu.test(text);
}

function inferCodingCliDirective(text: string): "codex" | "gemini" | undefined {
  if (/(gemini\s*cli|谷歌\s*cli|(?:调用|运行)\s*(gemini|谷歌)\s*cli|(?:交给|让|帮我用)\s*(gemini|谷歌)(?:\s*cli)?|(?:^|\s)用\s*(gemini|谷歌)(?:\s*cli)?)/iu.test(text)) {
    return "gemini";
  }

  if (/(codex\s*cli|(?:调用|运行)\s*codex\s*cli|(?:交给|让|帮我用)\s*codex(?:\s*cli)?|(?:^|\s)用\s*codex(?:\s*cli)?)/iu.test(text)) {
    return "codex";
  }

  return undefined;
}

function inferDirectCodexFixDirective(text: string): boolean {
  if (inferCodingCliDirective(text) === "gemini") {
    return false;
  }

  const normalized = text.trim();
  const fixIntent = /(修复|修一下|改一下|改下|改一改|修改|修bug|fix|debug|排查并修|处理一下这个bug)/iu.test(normalized);
  const codingTarget = /(bug|报错|问题|代码|项目|仓库|repo|接口|服务|功能|逻辑|脚本|定时任务|推送)/iu.test(normalized);
  return fixIntent && codingTarget;
}

function inferCollaborativeCodexDiscussionDirective(text: string): boolean {
  return /(复杂任务|复杂改动|复杂需求|多模型讨论|先讨论方案|先出方案|所有高级模型|全部高级模型|全高级模型|由\s*codex\s*执行|再由\s*codex\s*执行|最后交给\s*codex)/iu.test(text)
    && /(codex|调用\s*codex|用\s*codex|交给\s*codex|让\s*codex)/iu.test(text);
}

function inferRestartPhaseDirective(text: string): "audit_pending" | undefined {
  if (/(从审核阶段重新开始|从审核阶段重来|从审核重新开始|从审核重跑)/iu.test(text)) {
    return "audit_pending";
  }
  return undefined;
}

function normalizeQualityDirective(value?: string): TaskQualityLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/(strict|严格)/u.test(normalized)) return "strict";
  if (/(high|高)/u.test(normalized)) return "high";
  if (/(low|低|快)/u.test(normalized)) return "fast";
  if (/(standard|标准|普通)/u.test(normalized)) return "standard";
  return undefined;
}

function normalizeRiskDirective(value?: string): TaskRiskLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/(critical|极高|严重)/u.test(normalized)) return "critical";
  if (/(high|高)/u.test(normalized)) return "high";
  if (/(medium|中)/u.test(normalized)) return "medium";
  if (/(low|低)/u.test(normalized)) return "low";
  return undefined;
}

function normalizeComplexityDirective(value?: string): TaskComplexity | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/(hard|复杂|困难|高)/u.test(normalized)) return "hard";
  if (/(medium|中等|一般)/u.test(normalized)) return "medium";
  if (/(easy|简单|低)/u.test(normalized)) return "easy";
  return undefined;
}

function normalizeAuditDirective(value?: string): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/(否|不用|false|no)/u.test(normalized)) return false;
  if (/(是|需要|true|yes)/u.test(normalized)) return true;
  return undefined;
}

function inferRouteOverrides(text: string): Record<string, unknown> | undefined {
  const normalized = text.toLowerCase();

  if (/(换|用).*(gemini|谷歌).*(出图|图片|海报|配图|封面图)/.test(normalized)) {
    return {
      draftProvider: "gemini_web",
      finalArbiter: "gemini_web",
      reviewers: ["deepseek_web"],
    };
  }

  if (/(换|用).*(gpt|chatgpt).*(出图|图片|海报|配图|封面图)/.test(normalized)) {
    return {
      draftProvider: "chatgpt_web",
      finalArbiter: "chatgpt_web",
      reviewers: ["deepseek_web"],
    };
  }

  if (/(换|用).*(豆包).*(出图|图片|海报|配图|封面图)/.test(normalized)) {
    return {
      draftProvider: "doubao_web",
      finalArbiter: "doubao_web",
      reviewers: ["deepseek_web"],
    };
  }

  return undefined;
}

function inferRealtimeRouteOverrides(text: string): Record<string, unknown> | undefined {
  if (!hasRealtimeInfoNeed(text)) {
    return undefined;
  }

  const inferredIntent = inferTaskIntent({
    input: text,
    source: "feishu",
    sourceMeta: {},
  });
  if (inferredIntent !== "qa") {
    return undefined;
  }

  return {
    draftProvider: "qwen_web",
    fallbackProviders: ["deepseek_web", "doubao_web", "gemini_web"],
  };
}
