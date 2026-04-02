# Extension Guide

这个项目现在支持在服务启动层注入扩展，避免二次开发时直接改主流程。

当前可注入的能力：

- `createProviders`
- `createExecutors`
- `createNotifiers`
- `approvalPolicies`
- `registerRoutes`
- `onServicesCreated`

## 适合扩展的场景

- 新增一个内部专用 provider
- 把企业自己的通知渠道接进任务完成回调
- 增加自定义审批策略
- 新增内部 API 或运维接口
- 给特定任务类型增加专属工件执行器

## 示例：注册一个自定义扩展

```ts
import type { ServerExtension } from "../apps/server/src/extensions";
import { buildApp } from "../apps/server/src/app";

const customExtension: ServerExtension = {
  name: "internal-ops",
  approvalPolicies: [
    {
      key: "internal_high_risk",
      name: "Internal High Risk",
      mode: "manual",
      priority: 120,
      matchKeywords: ["生产", "上线", "删除数据"],
    },
  ],
  async registerRoutes(app) {
    app.get("/internal/ping", async () => {
      return { ok: true };
    });
  },
};

const app = await buildApp(process.cwd(), {
  extensions: [customExtension],
});
```

## 示例：注入自定义 notifier

```ts
import type { ServerExtension } from "../apps/server/src/extensions";
import type { TaskNotifier, TaskRecord } from "@office-agent/core";

class ConsoleNotifier implements TaskNotifier {
  async notifyTaskAccepted(task: TaskRecord): Promise<void> {
    console.log("accepted", task.id);
  }

  async notifyTaskCompleted(task: TaskRecord): Promise<void> {
    console.log("completed", task.id);
  }

  async notifyTaskFailed(task: TaskRecord): Promise<void> {
    console.log("failed", task.id, task.error);
  }

  async notifyProviderAttention(provider: string, detail: string): Promise<void> {
    console.log("provider attention", provider, detail);
  }
}

export const customExtension: ServerExtension = {
  name: "console-notifier",
  async createNotifiers() {
    return [new ConsoleNotifier()];
  },
};
```

## 示例：注入自定义 provider

扩展里返回 `ProviderAdapter` 实例即可，它会和内置 provider 一起进入 `ProviderRegistry`。

```ts
import type {
  ProviderAdapter,
  ProviderCompletion,
  ProviderHealth,
  ProviderPromptRequest,
  ProviderRunHandle,
  ProviderRunResult,
  SessionState,
} from "@office-agent/core";

export class InternalProvider implements ProviderAdapter {
  readonly name = "internal_provider";
  readonly kind = "api" as const;

  getConfig() {
    return {
      name: this.name,
      enabled: true,
      mode: "api" as const,
      allowedDomains: [],
      headless: true,
      timeoutMs: 30000,
      maxConcurrency: 2,
      rateLimitPerMinute: 60,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      status: "available",
      detail: "ok",
      checkedAt: new Date(),
    };
  }

  async ensureSession(): Promise<SessionState> {
    return { ok: true };
  }

  async sendPrompt(_request: ProviderPromptRequest): Promise<ProviderRunHandle> {
    throw new Error("Implement me");
  }

  async waitForCompletion(_handle: ProviderRunHandle): Promise<ProviderCompletion> {
    throw new Error("Implement me");
  }

  async extractAnswer(_completion: ProviderCompletion): Promise<ProviderRunResult> {
    throw new Error("Implement me");
  }

  async screenshotOnFailure(): Promise<string | undefined> {
    return undefined;
  }

  manualRecoveryHint(): string {
    return "Check internal provider status.";
  }
}
```

## 实践建议

- 扩展尽量只做追加，不要重写主流程
- 把企业私有逻辑放在独立扩展文件里，后续升级更容易
- 如果要加自定义 route，优先放在独立命名空间下，如 `/internal/*`
- 如果要处理敏感通知，避免在 notifier 中直接打印真实密钥或完整业务正文
