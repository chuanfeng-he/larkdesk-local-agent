import type { TaskNotifier } from "@office-agent/core";
import type { TaskRecord } from "@office-agent/core";
import { CompositeNotifier, FeishuBotApp, FeishuNotifier, NoopNotifier } from "@office-agent/feishu";

export class ServerTaskNotifier implements TaskNotifier {
  private readonly composite: CompositeNotifier;
  private feishuBot: FeishuBotApp | null;

  constructor(
    private readonly webhookNotifier: FeishuNotifier | NoopNotifier,
    feishuBot?: FeishuBotApp,
    extraNotifiers: TaskNotifier[] = [],
  ) {
    this.feishuBot = feishuBot ?? null;
    this.composite = new CompositeNotifier([webhookNotifier, ...extraNotifiers]);
  }

  setFeishuBot(feishuBot: FeishuBotApp): void {
    this.feishuBot = feishuBot;
  }

  async notifyTaskAccepted(task: TaskRecord): Promise<void> {
    await this.composite.notifyTaskAccepted(task);
  }

  async notifyTaskCompleted(task: TaskRecord): Promise<void> {
    await this.composite.notifyTaskCompleted(task);
    await this.feishuBot?.replyTaskResult(task).catch((error: unknown) => {
      console.error("Failed to send Feishu task result:", error);
    });
  }

  async notifyTaskFailed(task: TaskRecord): Promise<void> {
    await this.composite.notifyTaskFailed(task);
    await this.feishuBot?.replyTaskFailure(task).catch((error: unknown) => {
      console.error("Failed to send Feishu task failure:", error);
    });
  }

  async notifyProviderAttention(provider: string, detail: string, hint?: string): Promise<void> {
    await this.composite.notifyProviderAttention(provider, detail, hint);
  }
}
