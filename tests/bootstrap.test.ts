import { afterEach, describe, expect, it } from "vitest";
import type {
  ProviderAdapter,
  ProviderCompletion,
  ProviderHealth,
  ProviderPromptRequest,
  ProviderRunHandle,
  ProviderRunResult,
  SessionState,
} from "../packages/core/src";
import { createServices } from "../apps/server/src/bootstrap";

describe("createServices", () => {
  afterEach(() => {
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.FEISHU_USE_LONG_CONNECTION;
    delete process.env.CONFIG_HOT_RELOAD;
  });

  it("does not start scheduler for helper-style bootstraps", async () => {
    process.env.SCHEDULER_ENABLED = "true";
    process.env.FEISHU_USE_LONG_CONNECTION = "false";
    process.env.CONFIG_HOT_RELOAD = "false";

    const services = await createServices(process.cwd(), { startFeishuLongConnection: false });

    try {
      expect(services.scheduler?.["timers"].length ?? 0).toBe(0);
    } finally {
      services.scheduler?.stop();
      await services.registry.closeAll().catch(() => undefined);
      await services.prisma.$disconnect().catch(() => undefined);
      await services.app.close().catch(() => undefined);
    }
  });

  it("accepts extension providers and approval policies", async () => {
    process.env.SCHEDULER_ENABLED = "false";
    process.env.FEISHU_USE_LONG_CONNECTION = "false";
    process.env.CONFIG_HOT_RELOAD = "false";

    const fakeProvider: ProviderAdapter = {
      name: "test_extension_provider",
      kind: "mock",
      getConfig() {
        return {
          name: "test_extension_provider",
          enabled: true,
          mode: "api",
          allowedDomains: [],
          headless: true,
          timeoutMs: 1_000,
          maxConcurrency: 1,
          rateLimitPerMinute: 60,
        };
      },
      async healthCheck(): Promise<ProviderHealth> {
        return {
          provider: "test_extension_provider",
          status: "available",
          detail: "ok",
          checkedAt: new Date(),
        };
      },
      async ensureSession(): Promise<SessionState> {
        return { ok: true, detail: "ready" };
      },
      async sendPrompt(_request: ProviderPromptRequest): Promise<ProviderRunHandle> {
        throw new Error("Not implemented in test provider.");
      },
      async waitForCompletion(_handle: ProviderRunHandle): Promise<ProviderCompletion> {
        throw new Error("Not implemented in test provider.");
      },
      async extractAnswer(_completion: ProviderCompletion): Promise<ProviderRunResult> {
        throw new Error("Not implemented in test provider.");
      },
      async screenshotOnFailure(): Promise<string | undefined> {
        return undefined;
      },
      manualRecoveryHint(): string {
        return "No recovery needed.";
      },
      async close(): Promise<void> {},
    };

    const services = await createServices(process.cwd(), {
      startFeishuLongConnection: false,
      extensions: [
        {
          name: "test-extension",
          async createProviders() {
            return [fakeProvider];
          },
          approvalPolicies: [
            {
              key: "test_extension_policy",
              name: "Test Extension Policy",
              mode: "observe",
              priority: 88,
              matchKeywords: ["ext-test"],
            },
          ],
        },
      ],
    });

    try {
      expect(services.registry.get("test_extension_provider")).toBe(fakeProvider);
      const policies = await services.store.listApprovalPolicies();
      expect(policies.some((policy) => policy.key === "test_extension_policy")).toBe(true);
    } finally {
      services.scheduler?.stop();
      await services.registry.closeAll().catch(() => undefined);
      await services.prisma.$disconnect().catch(() => undefined);
      await services.app.close().catch(() => undefined);
    }
  });
});
