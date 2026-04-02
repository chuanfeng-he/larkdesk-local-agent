import { AbstractProviderAdapter } from "@office-agent/core";
import type {
  ProviderCompletion,
  ProviderHealth,
  ProviderPromptRequest,
  ProviderRunHandle,
  ProviderRuntimeConfig,
  SessionState,
} from "@office-agent/core";

interface MockHandleMeta {
  answer: string;
}

export class MockProvider extends AbstractProviderAdapter {
  readonly kind = "mock" as const;

  constructor(config: ProviderRuntimeConfig) {
    super(config.name, config);
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      status: this.config.enabled ? "available" : "disabled",
      detail: this.config.enabled ? "Mock provider ready." : "Mock provider disabled.",
      checkedAt: new Date(),
    };
  }

  async ensureSession(): Promise<SessionState> {
    return {
      ok: this.config.enabled,
      detail: this.config.enabled ? "Mock provider does not require login." : "Provider disabled.",
      requiresManualLogin: false,
    };
  }

  async sendPrompt(request: ProviderPromptRequest): Promise<ProviderRunHandle> {
    return this.schedule(async () => {
      const answer = createMockAnswer(this.name, request);
      return {
        provider: this.name,
        startedAt: new Date(),
        meta: {
          answer,
        } satisfies MockHandleMeta,
      };
    });
  }

  async waitForCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion> {
    return {
      provider: handle.provider,
      completedAt: new Date(),
      meta: handle.meta,
    };
  }

  async extractAnswer(completion: ProviderCompletion): Promise<{
    provider: string;
    outputText: string;
    summary: string;
  }> {
    const answer = ((completion.meta ?? {}) as unknown as MockHandleMeta).answer ?? "Mock provider returned no answer.";
    return {
      provider: this.name,
      outputText: answer,
      summary: this.summarize(answer),
    };
  }

  manualRecoveryHint(): string {
    return "Mock provider does not require manual recovery.";
  }
}

function createMockAnswer(providerName: string, request: ProviderPromptRequest): string {
  if (request.taskType === "CODING") {
    return [
      `Provider: ${providerName}`,
      "建议拆成四段:",
      "1. 搭建 Fastify + Core + Storage 的最小主链路。",
      "2. 先用 MockProvider 跑通 SIMPLE/COMPLEX/CODING 三条流程。",
      "3. 再接入 ChatGPT Web 的 Playwright 适配器，保留 selector profile 可配。",
      "4. 最后生成 Codex handoff 产物，并把执行状态回推飞书。",
    ].join("\n");
  }

  if (request.taskType === "COMPLEX") {
    return `这是来自 ${providerName} 的演示复核结果：建议先给出草稿，再做复审，最后由主模型做仲裁。`;
  }

  return `这是来自 ${providerName} 的演示回复。当前主链路可用，但这次没有命中真实网页模型，所以返回了本地 mock 结果。`;
}
