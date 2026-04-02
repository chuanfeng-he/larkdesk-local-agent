import { describe, expect, it } from "vitest";
import { buildFeishuSubmission } from "../packages/integrations/feishu/src/index";
import { inferTier } from "../packages/core/src/classifier";
import { RouterV2 } from "../packages/core/src/router-v2";
import type {
  ProviderAdapter,
  ProviderCompletion,
  ProviderHealth,
  ProviderPromptRequest,
  ProviderRunHandle,
  ProviderRunResult,
  ProviderRuntimeConfig,
  RoutingPolicy,
  SessionState,
  WorkflowMeta,
} from "../packages/core/src/types";

describe("complex coding discussion routing", () => {
  it("keeps multi-model discussion before codex auto-run", () => {
    const submission = buildFeishuSubmission(
      "这是个复杂任务，先让所有高级模型讨论方案，再由 codex 执行修改项目代码",
      {},
    );

    expect(submission.requestedType).toBe("CODING");
    expect(submission.requestedIntent).toBe("coding");
    expect(submission.executionPolicy?.discussionMode).toBe("all_advanced");
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown>).autoRunCodex).toBe(true);
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown>).directToCodex).toBeUndefined();
  });

  it("routes bug-fix requests directly to Codex by default", () => {
    const submission = buildFeishuSubmission(
      "帮我修复下这个bug，修复好了和我说一声",
      {},
    );

    expect(submission.requestedType).toBe("CODING");
    expect(submission.requestedIntent).toBe("coding");
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown>).autoRunCodex).toBe(true);
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown>).directToCodex).toBe(true);
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown>).directCliRunner).toBe("codex");
  });

  it("does not misclassify gemini api questions as direct Gemini CLI work", () => {
    const submission = buildFeishuSubmission(
      "你现在调用gemini的api还是被限额的状态吗",
      {},
    );

    expect(submission.requestedType).not.toBe("CODING");
    expect(submission.requestedIntent).not.toBe("coding");
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown> | undefined)?.directToCodex).toBeUndefined();
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown> | undefined)?.directCliRunner).toBeUndefined();
  });

  it("still routes explicit Gemini CLI requests to the local gemini runner", () => {
    const submission = buildFeishuSubmission(
      "帮我用 gemini cli 看下这个仓库的架构",
      {},
    );

    expect(submission.requestedType).toBe("CODING");
    expect(submission.requestedIntent).toBe("coding");
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown>).directToCodex).toBe(true);
    expect((submission.sourceMeta?.routeOverrides as Record<string, unknown>).directCliRunner).toBe("gemini");
  });

  it("captures image sub-intents like edit and avatar in source meta", () => {
    const editSubmission = buildFeishuSubmission(
      "帮我把这张图重绘成宫崎骏风",
      {},
    );
    const avatarSubmission = buildFeishuSubmission(
      "帮我做一个微信头像，可爱一点",
      {},
    );

    expect(editSubmission.requestedIntent).toBe("image");
    expect((editSubmission.sourceMeta as Record<string, unknown>).imageRequestKind).toBe("edit");
    expect(avatarSubmission.requestedIntent).toBe("image");
    expect((avatarSubmission.sourceMeta as Record<string, unknown>).imageRequestKind).toBe("avatar");
  });

  it("routes realtime rule questions out of the T1 API fast path", () => {
    const submission = buildFeishuSubmission(
      "合肥云闪付有奖发票活动，第二期抽奖的发票时间，必须是4月1号及以后日期的吗",
      {},
    );

    expect(inferTier(submission)).toBe("T2");
    expect(((submission.sourceMeta as Record<string, unknown>).routeOverrides as Record<string, unknown>).draftProvider).toBe("qwen_web");
    expect(((submission.sourceMeta as Record<string, unknown>).routeOverrides as Record<string, unknown>).fallbackProviders).toEqual([
      "deepseek_web",
      "doubao_web",
      "gemini_web",
    ]);
    expect((submission.presetHints as Record<string, unknown>)?.preferredReasoning).toBe("pro");
  });

  it("prefers web providers for non-T1 simple QA routing", () => {
    const policy: RoutingPolicy = {
      ...routingPolicy,
      simple: {
        cheapProviders: ["gemini_api", "deepseek_web", "doubao_web"],
        fallbackProviders: ["qwen_web"],
      },
    };
    const router = new RouterV2(policy, [
      createProvider("gemini_api", "cheap", ["cheap_chat"], "api"),
      createProvider("deepseek_web", "cheap", ["cheap_chat"], "mock"),
      createProvider("doubao_web", "cheap", ["cheap_chat"], "mock"),
      createProvider("qwen_web", "mid", ["cheap_chat"], "mock"),
    ]);

    const route = router.route("SIMPLE", {
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
    });

    expect(route.draftProvider).toBe("deepseek_web");
  });

  it("expands reviewers to all advanced coding reviewers", () => {
    const workflow: WorkflowMeta = {
      tier: "T3",
      intent: "coding",
      budget: "high",
      artifactType: "none",
      qualityLevel: "high",
      riskLevel: "high",
      complexity: "hard",
      complexityScore: 0.9,
      audit: {
        requested: false,
        required: false,
        triggers: [],
        strategy: "structured_gate",
        maxRevisionRounds: 1,
      },
      selectedSkills: [],
      executionPolicy: {
        discussionMode: "all_advanced",
      },
    };

    const route = new RouterV2(routingPolicy, providers).route("CODING", workflow);

    expect(route.reviewers).toEqual(["claude_web", "gemini_web", "grok_web", "qwen_web"]);
    expect(route.finalArbiter).toBe("chatgpt_web");
    expect(route.autoRunCodex).toBe(true);
  });
});

const routingPolicy: RoutingPolicy = {
  defaults: {
    budget: {
      default: "standard",
      multiReviewerMinBudget: "high",
    },
    review: {
      defaultCount: 1,
      upgradedCount: 2,
    },
    presets: {
      simple: "standard",
      office: "standard",
      artifact: "pro",
      review: "pro",
      arbiter: "pro",
      audit: "pro",
      highRisk: "expert",
      strictQuality: "deep",
    },
    audit: {
      maxAttempts: 4,
      lowRiskProviders: ["qwen_web"],
      mediumRiskProviders: ["qwen_web"],
      highRiskProviders: ["claude_web", "chatgpt_web", "gemini_web", "grok_web", "qwen_web"],
      criticalRiskProviders: ["claude_web", "chatgpt_web", "gemini_web", "grok_web", "qwen_web"],
    },
  },
  simple: {
    cheapProviders: ["deepseek_web"],
    fallbackProviders: ["qwen_web"],
  },
  office: {
    draftProvider: "doubao_web",
    fallbackProviders: ["qwen_web"],
    reviewer: "deepseek_web",
    extraReviewers: ["gemini_web", "claude_web", "qwen_web", "grok_web"],
    finalArbiter: "chatgpt_web",
  },
  doc: {
    draftProvider: "doubao_web",
    fallbackProviders: ["qwen_web"],
    reviewer: "deepseek_web",
    extraReviewers: ["gemini_web", "claude_web", "qwen_web", "grok_web"],
    finalArbiter: "chatgpt_web",
    executor: "doc_markdown",
  },
  image: {
    draftProvider: "doubao_web",
    reviewer: "deepseek_web",
    extraReviewers: ["gemini_web"],
    finalArbiter: "chatgpt_web",
    executor: "image_prompt",
  },
  ppt: {
    draftProvider: "doubao_web",
    reviewer: "deepseek_web",
    extraReviewers: ["gemini_web", "claude_web", "qwen_web", "grok_web"],
    finalArbiter: "chatgpt_web",
    executor: "ppt_markdown",
  },
  video: {
    draftProvider: "doubao_web",
    reviewer: "deepseek_web",
    extraReviewers: ["gemini_web", "qwen_web", "grok_web"],
    finalArbiter: "chatgpt_web",
    executor: "video_plan",
  },
  coding: {
    draftProvider: "deepseek_web",
    reviewer: "doubao_web",
    extraReviewers: ["gemini_web", "claude_web", "qwen_web", "grok_web"],
    finalArbiter: "chatgpt_web",
    codex: {
      autoRun: true,
    },
  },
};

const providers: ProviderAdapter[] = [
  createProvider("mock_provider", "cheap", ["coding_review", "coding_arbiter"]),
  createProvider("deepseek_web", "cheap", ["coding_draft", "coding_review"]),
  createProvider("doubao_web", "cheap", ["coding_review"]),
  createProvider("qwen_web", "mid", ["coding_review"]),
  createProvider("gemini_web", "mid", ["coding_review", "coding_arbiter"]),
  createProvider("claude_web", "strong", ["coding_review", "coding_arbiter"]),
  createProvider("grok_web", "strong", ["coding_review", "coding_arbiter"]),
  createProvider("chatgpt_web", "strong", ["coding_arbiter"]),
];

function createProvider(
  name: string,
  tier: ProviderRuntimeConfig["tier"],
  capabilities: NonNullable<ProviderRuntimeConfig["capabilities"]>,
  kind: ProviderAdapter["kind"] = "mock",
): ProviderAdapter {
  const config: ProviderRuntimeConfig = {
    name,
    enabled: true,
    tier,
    capabilities,
    mode: "persistent",
    allowedDomains: [],
    headless: true,
    timeoutMs: 10_000,
    maxConcurrency: 1,
    rateLimitPerMinute: 60,
    defaultPreset: "standard",
    presets: {
      standard: {
        reasoningIntensity: "medium",
        costLevel: tier === "cheap" ? "low" : "medium",
        contextWindow: "medium",
      },
      pro: {
        reasoningIntensity: "high",
        costLevel: "high",
        contextWindow: "high",
      },
      expert: {
        reasoningIntensity: "very_high",
        costLevel: "premium",
        contextWindow: "very_high",
      },
    },
  };

  return {
    name,
    kind,
    getConfig(): ProviderRuntimeConfig {
      return config;
    },
    async healthCheck(): Promise<ProviderHealth> {
      return { provider: name, status: "available", detail: "ok", checkedAt: new Date() };
    },
    async ensureSession(): Promise<SessionState> {
      return { ok: true, detail: "ok" };
    },
    async sendPrompt(_request: ProviderPromptRequest): Promise<ProviderRunHandle> {
      return { provider: name, startedAt: new Date() };
    },
    async waitForCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion> {
      return { provider: handle.provider, completedAt: new Date() };
    },
    async extractAnswer(completion: ProviderCompletion): Promise<ProviderRunResult> {
      return { provider: completion.provider, outputText: "ok", summary: "ok" };
    },
    async screenshotOnFailure(): Promise<string | undefined> {
      return undefined;
    },
    manualRecoveryHint(): string {
      return "none";
    },
  };
}
