import type { ProviderAdapter, RoutingPolicy, WorkflowMeta, WorkflowRoutePlan } from "./types";

export class RouterV2 {
  constructor(
    private readonly routingPolicy: RoutingPolicy,
    private readonly providers: ProviderAdapter[],
  ) {}

  route(taskType: WorkflowRouteInput["taskType"], workflow: WorkflowMeta): WorkflowRoutePlan {
    if (workflow.intent === "qa" && taskType === "SIMPLE") {
      // T1 tier: prefer API providers (gemini_api) for fast response
      const preferApi = workflow.tier === "T1";
      const orderedProviders = preferApi
        ? this.prioritizeApiProviders(this.routingPolicy.simple.cheapProviders)
        : this.prioritizeWebProviders(this.routingPolicy.simple.cheapProviders);

      const draftProvider = this.pickPreferred(
        orderedProviders,
        "cheap_chat",
        "mock_provider",
      );

      return {
        kind: "simple",
        draftProvider,
        fallbackProviders: this.pickMany(this.routingPolicy.simple.fallbackProviders, "cheap_chat", [draftProvider]),
        reviewers: [],
        useLocalAccess: false,
        autoRunCodex: false,
      };
    }

    if (taskType === "CODING" || workflow.intent === "coding") {
      const useReview = shouldUseMultiModelReview(workflow);
      const draftProvider = this.pickPreferred([this.routingPolicy.coding.draftProvider], "coding_draft", "mock_provider");
      return {
        kind: "coding",
        draftProvider,
        fallbackProviders: [],
        reviewers: useReview
          ? this.buildDiscussionReviewers(
              this.routingPolicy.coding.reviewer,
              this.routingPolicy.coding.extraReviewers,
              "coding_review",
              workflow,
              [draftProvider],
            )
          : [],
        finalArbiter: useReview
          ? this.pickDiscussionArbiter(
              [this.routingPolicy.coding.finalArbiter],
              "coding_arbiter",
              workflow,
              [draftProvider],
            )
          : undefined,
        useLocalAccess: true,
        autoRunCodex: this.routingPolicy.coding.codex.autoRun,
      };
    }

    if (workflow.intent === "doc") {
      const draftProvider = this.pickPreferred([this.routingPolicy.doc.draftProvider], "doc_draft", "mock_provider");
      const useReview = shouldUseMultiModelReview(workflow);
      return {
        kind: "doc",
        draftProvider,
        fallbackProviders: this.pickMany(this.routingPolicy.doc.fallbackProviders ?? [], "doc_draft", [draftProvider]),
        reviewers: useReview
          ? this.buildDiscussionReviewers(
              this.routingPolicy.doc.reviewer,
              this.routingPolicy.doc.extraReviewers,
              "doc_review",
              workflow,
              [draftProvider],
            )
          : [],
        finalArbiter: useReview
          ? this.pickDiscussionArbiter(
              [this.routingPolicy.doc.finalArbiter],
              "office_arbiter",
              workflow,
              [draftProvider],
            )
          : undefined,
        executor: this.routingPolicy.doc.executor,
        useLocalAccess: true,
        autoRunCodex: false,
      };
    }

    if (workflow.intent === "image") {
      return {
        kind: "image",
        draftProvider: this.pickPreferred([this.routingPolicy.image.draftProvider], "image_draft", "mock_provider"),
        fallbackProviders: [],
        // Real image generation is a single-provider flow. Avoid duplicate renders.
        reviewers: [],
        finalArbiter: undefined,
        executor: this.routingPolicy.image.executor,
        useLocalAccess: false,
        autoRunCodex: false,
      };
    }

    if (workflow.intent === "ppt") {
      const useReview = shouldUseMultiModelReview(workflow);
      const draftProvider = this.pickPreferred([this.routingPolicy.ppt.draftProvider], "ppt_draft", "mock_provider");
      return {
        kind: "ppt",
        draftProvider,
        fallbackProviders: [],
        reviewers: useReview
          ? this.buildDiscussionReviewers(
              this.routingPolicy.ppt.reviewer,
              this.routingPolicy.ppt.extraReviewers,
              "ppt_review",
              workflow,
              [draftProvider],
            )
          : [],
        finalArbiter: useReview
          ? this.pickDiscussionArbiter(
              [this.routingPolicy.ppt.finalArbiter],
              "office_arbiter",
              workflow,
              [draftProvider],
            )
          : undefined,
        executor: this.routingPolicy.ppt.executor,
        useLocalAccess: true,
        autoRunCodex: false,
      };
    }

    if (workflow.intent === "video") {
      const useReview = shouldUseMultiModelReview(workflow);
      const draftProvider = this.pickPreferred([this.routingPolicy.video.draftProvider], "video_draft", "mock_provider");
      return {
        kind: "video",
        draftProvider,
        fallbackProviders: [],
        reviewers: useReview
          ? this.buildDiscussionReviewers(
              this.routingPolicy.video.reviewer,
              this.routingPolicy.video.extraReviewers,
              "video_review",
              workflow,
              [draftProvider],
            )
          : [],
        finalArbiter: useReview
          ? this.pickDiscussionArbiter(
              [this.routingPolicy.video.finalArbiter],
              "office_arbiter",
              workflow,
              [draftProvider],
            )
          : undefined,
        executor: this.routingPolicy.video.executor,
        useLocalAccess: false,
        autoRunCodex: false,
      };
    }

    const officeDraftProvider = this.pickPreferred([this.routingPolicy.office.draftProvider], "office_draft", "mock_provider");
    const useReview = shouldUseMultiModelReview(workflow);
    return {
      kind: "office",
      draftProvider: officeDraftProvider,
      fallbackProviders: this.pickMany(this.routingPolicy.office.fallbackProviders ?? [], "office_draft", [officeDraftProvider]),
      reviewers: useReview
        ? this.buildDiscussionReviewers(
            this.routingPolicy.office.reviewer,
            this.routingPolicy.office.extraReviewers,
            "office_review",
            workflow,
            [officeDraftProvider],
          )
        : [],
      finalArbiter: useReview
        ? this.pickDiscussionArbiter(
            [this.routingPolicy.office.finalArbiter],
            "office_arbiter",
            workflow,
            [officeDraftProvider],
          )
        : undefined,
      useLocalAccess: false,
      autoRunCodex: false,
    };
  }

  /** Move API-mode providers to the front of the list for T1 fast path. */
  private prioritizeApiProviders(providerNames: string[]): string[] {
    const apiFirst: string[] = [];
    const rest: string[] = [];
    for (const name of providerNames) {
      const provider = this.providers.find((p) => p.name === name);
      if (provider?.kind === "api" && provider.getConfig().enabled) {
        apiFirst.push(name);
      } else {
        rest.push(name);
      }
    }
    return [...apiFirst, ...rest];
  }

  /** Move web-mode providers to the front for current-info or non-fast-path simple tasks. */
  private prioritizeWebProviders(providerNames: string[]): string[] {
    const webFirst: string[] = [];
    const rest: string[] = [];
    for (const name of providerNames) {
      const provider = this.providers.find((p) => p.name === name);
      if (provider && provider.kind !== "api" && provider.getConfig().enabled) {
        webFirst.push(name);
      } else {
        rest.push(name);
      }
    }
    return [...webFirst, ...rest];
  }

  private buildDiscussionReviewers(
    primary: string,
    extras: string[],
    capability: ProviderCapabilityKey,
    workflow: WorkflowMeta,
    exclude: string[] = [],
  ): string[] {
    if (workflow.executionPolicy?.discussionMode === "all_advanced") {
      return this.pickAdvancedMany(capability, exclude);
    }

    const reviewers = [this.pickPreferred([primary], capability, "mock_provider")];
    const minBudget = this.routingPolicy.defaults.budget.multiReviewerMinBudget;
    const allowExtras = compareBudget(workflow.budget, minBudget) >= 0;

    if (!allowExtras) {
      return reviewers;
    }

    return [...reviewers, ...this.pickMany(extras, capability, reviewers)];
  }

  private pickDiscussionArbiter(
    preferred: string[],
    capability: ProviderCapabilityKey,
    workflow: WorkflowMeta,
    exclude: string[] = [],
  ): string {
    if (workflow.executionPolicy?.discussionMode === "all_advanced") {
      const configured = this.pickPreferred(preferred, capability, "");
      if (configured && configured !== "mock_provider") {
        return configured;
      }
      return this.pickAdvancedArbiter(capability, exclude);
    }

    return this.pickPreferred(preferred, capability, "mock_provider");
  }

  private pickPreferred(preferred: string[], capability: ProviderCapabilityKey, fallback: string): string {
    for (const name of preferred) {
      const provider = this.providers.find((entry) => entry.name === name);
      if (provider && provider.getConfig().enabled) {
        return provider.name;
      }
    }

    const byCapability = this.providers.find((provider) => {
      const config = provider.getConfig();
      return config.enabled && (config.capabilities ?? []).includes(capability);
    });

    return byCapability?.name ?? fallback;
  }

  private pickMany(preferred: string[], capability: ProviderCapabilityKey, exclude: string[] = []): string[] {
    const picked = preferred.filter((name) => {
      if (exclude.includes(name)) {
        return false;
      }

      const provider = this.providers.find((entry) => entry.name === name);
      return Boolean(provider?.getConfig().enabled);
    });

    if (picked.length > 0) {
      return picked;
    }

    return this.providers
      .filter((provider) => {
        const config = provider.getConfig();
        return config.enabled && !exclude.includes(provider.name) && (config.capabilities ?? []).includes(capability);
      })
      .map((provider) => provider.name);
  }

  private pickAdvancedMany(capability: ProviderCapabilityKey, exclude: string[] = []): string[] {
    const prioritized = ["claude_web", "chatgpt_web", "gemini_web", "grok_web", "qwen_web", "deepseek_web", "doubao_web"];
    const picked = prioritized.filter((name) => {
      if (exclude.includes(name)) {
        return false;
      }

      const provider = this.providers.find((entry) => entry.name === name);
      if (!provider) {
        return false;
      }

      const config = provider.getConfig();
      const hasAdvancedPreset = Boolean(config.presets?.pro || config.presets?.expert || config.presets?.deep);
      return config.enabled
        && provider.name !== "mock_provider"
        && config.tier !== "cheap"
        && hasAdvancedPreset
        && (config.capabilities ?? []).includes(capability);
    });

    return picked.length > 0 ? picked : this.pickMany([], capability, exclude);
  }

  private pickAdvancedArbiter(capability: ProviderCapabilityKey, exclude: string[] = []): string {
    const preferred = ["claude_web", "chatgpt_web", "gemini_web", "grok_web", "qwen_web", "deepseek_web", "doubao_web"];
    for (const name of preferred) {
      if (exclude.includes(name)) {
        continue;
      }

      const provider = this.providers.find((entry) => entry.name === name);
      if (!provider) {
        continue;
      }

      const config = provider.getConfig();
      const hasAdvancedPreset = Boolean(config.presets?.pro || config.presets?.expert || config.presets?.deep);
      if (config.enabled && provider.name !== "mock_provider" && hasAdvancedPreset && (config.capabilities ?? []).includes(capability)) {
        return provider.name;
      }
    }

    return this.pickPreferred([], capability, "mock_provider");
  }
}

type WorkflowRouteInput = {
  taskType: "SIMPLE" | "COMPLEX" | "CODING";
};

type ProviderCapabilityKey =
  | "cheap_chat"
  | "office_draft"
  | "office_review"
  | "office_arbiter"
  | "coding_draft"
  | "coding_review"
  | "coding_arbiter"
  | "doc_draft"
  | "doc_review"
  | "image_draft"
  | "image_review"
  | "ppt_draft"
  | "ppt_review"
  | "video_draft"
  | "video_review";

function compareBudget(left: WorkflowMeta["budget"], right: WorkflowMeta["budget"]): number {
  const ranking = {
    low: 0,
    standard: 1,
    high: 2,
  } satisfies Record<WorkflowMeta["budget"], number>;

  return ranking[left] - ranking[right];
}

function shouldUseMultiModelReview(workflow: WorkflowMeta): boolean {
  if (workflow.intent === "office_discussion") {
    return true;
  }

  if (workflow.audit.required || workflow.audit.requested) {
    return true;
  }

  if (workflow.budget === "high") {
    return true;
  }

  if (workflow.qualityLevel === "high" || workflow.qualityLevel === "strict") {
    return true;
  }

  if (workflow.riskLevel === "high" || workflow.riskLevel === "critical") {
    return true;
  }

  return false;
}
