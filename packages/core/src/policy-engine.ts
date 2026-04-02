import type {
  AgentRole,
  ModelPresetName,
  ProviderAdapter,
  ProviderExecutionTarget,
  ProviderRuntimeConfig,
  RoutingPolicy,
  TaskType,
  WorkflowMeta,
  WorkflowModelPlan,
  WorkflowRoutePlan,
} from "./types";

const PRESET_RANK: Record<ModelPresetName, number> = {
  standard: 0,
  pro: 1,
  expert: 2,
  deep: 3,
};

const ORDERED_PRESETS: ModelPresetName[] = ["standard", "pro", "expert", "deep"];

export class PolicyEngine {
  private readonly providers = new Map<string, ProviderAdapter>();

  constructor(
    private readonly routingPolicy: RoutingPolicy,
    providers: ProviderAdapter[],
  ) {
    for (const provider of providers) {
      this.providers.set(provider.name, provider);
    }
  }

  decorateRoutePlan(taskType: TaskType, workflow: WorkflowMeta, route: WorkflowRoutePlan): WorkflowRoutePlan {
    const draftTarget = this.resolveTarget("zhongshu_drafter", route.draftProvider, taskType, workflow);
    const fallbackTargets = route.fallbackProviders.map((provider) =>
      this.resolveTarget("zhongshu_drafter", provider, taskType, workflow),
    );
    const reviewerTargets = route.reviewers.map((provider) =>
      this.resolveTarget("hanlin_reviewer", provider, taskType, workflow),
    );
    const finalArbiterTarget = route.finalArbiter
      ? this.resolveTarget("zhongshu_arbiter", route.finalArbiter, taskType, workflow)
      : undefined;
    const auditTargets = this.resolveAuditTargets(taskType, workflow, route);

    return {
      ...route,
      draftTarget,
      fallbackTargets,
      reviewerTargets,
      finalArbiterTarget,
      auditTarget: auditTargets[0],
      auditFallbackTargets: auditTargets.slice(1),
    };
  }

  buildModelPlan(route: WorkflowRoutePlan): WorkflowModelPlan {
    return {
      drafter: route.draftTarget,
      draftFallbacks: route.fallbackTargets ?? [],
      reviewers: route.reviewerTargets ?? [],
      auditor: route.auditTarget,
      auditFallbacks: route.auditFallbackTargets ?? [],
      arbiter: route.finalArbiterTarget,
    };
  }

  resolveTarget(
    role: AgentRole,
    providerName: string,
    taskType: TaskType,
    workflow: WorkflowMeta,
  ): ProviderExecutionTarget {
    const forcedProviderName =
      workflow.executionPolicy?.forceProvider && this.providers.has(workflow.executionPolicy.forceProvider)
        ? workflow.executionPolicy.forceProvider
        : providerName;
    const provider = this.providers.get(forcedProviderName);
    const config = provider?.getConfig();
    const desiredPreset = this.resolveDesiredPreset(role, taskType, workflow);
    const preset = this.resolveSupportedPreset(config, desiredPreset, workflow);
    const presetConfig = config?.presets?.[preset];
    return {
      role,
      provider: forcedProviderName,
      preset,
      timeoutMs: this.resolveTimeout(config, preset),
      fallbackPriority: presetConfig?.fallbackPriority,
    };
  }

  private resolveAuditTargets(taskType: TaskType, workflow: WorkflowMeta, route: WorkflowRoutePlan): ProviderExecutionTarget[] {
    const riskFallbacks =
      workflow.riskLevel === "critical"
        ? this.routingPolicy.defaults.audit.criticalRiskProviders
        : workflow.riskLevel === "high"
          ? this.routingPolicy.defaults.audit.highRiskProviders
          : workflow.riskLevel === "medium"
            ? this.routingPolicy.defaults.audit.mediumRiskProviders
            : this.routingPolicy.defaults.audit.lowRiskProviders;

    const chain = uniqueStrings([
      workflow.audit.provider,
      ...riskFallbacks,
      route.finalArbiter,
      ...route.reviewers,
      ...route.fallbackProviders,
      route.draftProvider,
    ]);

    const maxAttempts = Math.max(1, workflow.audit.maxAttempts ?? this.routingPolicy.defaults.audit.maxAttempts);
    return chain
      .slice(0, maxAttempts)
      .map((providerName) => this.resolveTarget("menxia_auditor", providerName, taskType, workflow));
  }

  private resolveDesiredPreset(role: AgentRole, taskType: TaskType, workflow: WorkflowMeta): ModelPresetName {
    const forced = workflow.executionPolicy?.forcePreset;
    if (forced) {
      return forced;
    }

    let desired: ModelPresetName =
      role === "zhongshu_drafter"
        ? workflow.intent === "qa" && taskType === "SIMPLE"
          ? this.routingPolicy.defaults.presets.simple
          : workflow.artifactType !== "none" || workflow.intent === "coding"
            ? this.routingPolicy.defaults.presets.artifact
            : this.routingPolicy.defaults.presets.office
        : role === "hanlin_reviewer"
          ? this.routingPolicy.defaults.presets.review
          : role === "menxia_auditor"
            ? this.routingPolicy.defaults.presets.audit
            : this.routingPolicy.defaults.presets.arbiter;

    if (workflow.complexity === "hard" || workflow.intent === "doc" || workflow.intent === "coding") {
      desired = atLeastPreset(desired, "pro");
    }

    if (workflow.riskLevel === "high" || workflow.riskLevel === "critical") {
      desired =
        role === "menxia_auditor"
          ? atLeastPreset(desired, "deep")
          : role === "hanlin_reviewer" || role === "zhongshu_arbiter"
            ? atLeastPreset(desired, this.routingPolicy.defaults.presets.highRisk)
            : atLeastPreset(desired, "pro");
    }

    if (workflow.qualityLevel === "high" || workflow.qualityLevel === "strict") {
      desired =
        role === "menxia_auditor"
          ? atLeastPreset(desired, this.routingPolicy.defaults.presets.strictQuality)
          : role === "hanlin_reviewer" || role === "zhongshu_arbiter"
            ? atLeastPreset(desired, "expert")
            : atLeastPreset(desired, "pro");
    }

    if (role === "menxia_auditor" && workflow.audit.required) {
      desired = atLeastPreset(desired, "pro");
    }

    const hinted = workflow.presetHints?.preferredReasoning;
    if (hinted && workflow.executionPolicy?.allowPresetUpgrade !== false) {
      desired = atLeastPreset(desired, hinted);
    }

    if (workflow.budget === "low" && workflow.executionPolicy?.allowPresetDowngrade !== false) {
      if (!(role === "menxia_auditor" && workflow.audit.required)) {
        desired = downgradePreset(desired);
      }
    }

    return desired;
  }

  private resolveSupportedPreset(
    config: ProviderRuntimeConfig | undefined,
    desired: ModelPresetName,
    workflow: WorkflowMeta,
  ): ModelPresetName {
    const available = ORDERED_PRESETS.filter((preset) => Boolean(config?.presets?.[preset]));
    if (available.length === 0) {
      return config?.defaultPreset ?? "standard";
    }

    if (available.includes(desired)) {
      return desired;
    }

    const allowDowngrade = workflow.executionPolicy?.allowPresetDowngrade !== false;
    const allowUpgrade = workflow.executionPolicy?.allowPresetUpgrade !== false;
    const desiredRank = PRESET_RANK[desired];

    if (allowDowngrade) {
      for (let rank = desiredRank - 1; rank >= 0; rank -= 1) {
        const preset = ORDERED_PRESETS[rank];
        if (preset && available.includes(preset)) {
          return preset;
        }
      }
    }

    if (allowUpgrade) {
      for (let rank = desiredRank + 1; rank < ORDERED_PRESETS.length; rank += 1) {
        const preset = ORDERED_PRESETS[rank];
        if (preset && available.includes(preset)) {
          return preset;
        }
      }
    }

    return available[0] ?? "standard";
  }

  private resolveTimeout(config: ProviderRuntimeConfig | undefined, preset: ModelPresetName): number {
    return config?.presets?.[preset]?.timeoutMs ?? config?.presets?.[preset]?.estimatedLatencyMs ?? config?.timeoutMs ?? 90_000;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function atLeastPreset(current: ModelPresetName, target: ModelPresetName): ModelPresetName {
  return PRESET_RANK[current] >= PRESET_RANK[target] ? current : target;
}

function downgradePreset(preset: ModelPresetName): ModelPresetName {
  const currentRank = PRESET_RANK[preset];
  const nextRank = Math.max(0, currentRank - 1);
  return ORDERED_PRESETS[nextRank] ?? "standard";
}
