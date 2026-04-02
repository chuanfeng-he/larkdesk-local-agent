import type {
  AgentRole,
  RoleDefinition,
  TaskRoleAssignment,
  TaskType,
  WorkflowMeta,
  WorkflowRolePlan,
  WorkflowRoutePlan,
} from "./types";

const BUILTIN_ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: "crown_orchestrator",
    title: "舰长",
    responsibility: "总领任务编排、决策状态流转与升级策略。",
    preferredCapabilities: [],
    preferredTiers: ["mid", "strong"],
    supportsHotSwap: false,
  },
  {
    id: "zhongshu_drafter",
    title: "首席科学官",
    responsibility: "负责首稿生成、任务拆解和初始方案输出。",
    preferredCapabilities: ["cheap_chat", "office_draft", "doc_draft", "image_draft", "ppt_draft", "video_draft", "coding_draft"],
    preferredTiers: ["cheap", "mid", "strong"],
    supportsHotSwap: true,
  },
  {
    id: "hanlin_reviewer",
    title: "大副",
    responsibility: "负责复审、补充边界条件和指出事实风险。",
    preferredCapabilities: ["office_review", "doc_review", "image_review", "ppt_review", "video_review", "coding_review"],
    preferredTiers: ["mid", "strong"],
    supportsHotSwap: true,
  },
  {
    id: "menxia_auditor",
    title: "安全官",
    responsibility: "负责制度化审核、质量门禁和驳回意见输出。",
    preferredCapabilities: ["office_review", "office_arbiter", "coding_review", "coding_arbiter"],
    preferredTiers: ["strong"],
    supportsHotSwap: true,
  },
  {
    id: "zhongshu_arbiter",
    title: "通讯官",
    responsibility: "负责整合多方意见并产出最终统一答复。",
    preferredCapabilities: ["office_arbiter", "coding_arbiter"],
    preferredTiers: ["strong"],
    supportsHotSwap: true,
  },
  {
    id: "shangshu_executor",
    title: "轮机长",
    responsibility: "负责文档、PPT、图片、视频等产物执行落地。",
    preferredCapabilities: [],
    preferredTiers: ["mid", "strong"],
    supportsHotSwap: false,
  },
  {
    id: "junji_implementer",
    title: "导航员",
    responsibility: "负责编码实施、Codex 交接与测试收口。",
    preferredCapabilities: ["coding_draft", "coding_review", "coding_arbiter"],
    preferredTiers: ["strong"],
    supportsHotSwap: true,
  },
  {
    id: "sitian_monitor",
    title: "瞭望塔",
    responsibility: "负责监控心跳、事件观测、告警与人工干预入口。",
    preferredCapabilities: [],
    preferredTiers: ["cheap", "mid", "strong"],
    supportsHotSwap: false,
  },
];

function toAssignment(
  role: AgentRole,
  title: string,
  mode: "required" | "optional",
  provider?: string,
  preset?: TaskRoleAssignment["preset"],
  timeoutMs?: number,
): TaskRoleAssignment {
  return {
    role,
    title,
    mode,
    provider,
    preset,
    timeoutMs,
  };
}

export class RoleRegistry {
  private readonly roles = new Map<AgentRole, RoleDefinition>();

  constructor(definitions: RoleDefinition[] = BUILTIN_ROLE_DEFINITIONS) {
    this.replaceAll(definitions);
  }

  list(): RoleDefinition[] {
    return [...this.roles.values()];
  }

  get(role: AgentRole): RoleDefinition | undefined {
    return this.roles.get(role);
  }

  replaceAll(definitions: RoleDefinition[]): void {
    this.roles.clear();
    for (const definition of definitions) {
      this.roles.set(definition.id, definition);
    }
  }

  buildPlan(taskType: TaskType, workflow: WorkflowMeta, route: WorkflowRoutePlan): WorkflowRolePlan {
    const chain: TaskRoleAssignment[] = [toAssignment("crown_orchestrator", "舰长", "required")];
    chain.push(
      toAssignment(
        "zhongshu_drafter",
        "首席科学官",
        "required",
        route.draftTarget?.provider ?? route.draftProvider,
        route.draftTarget?.preset,
        route.draftTarget?.timeoutMs,
      ),
    );

    for (const reviewer of route.reviewerTargets ?? route.reviewers.map((provider) => ({ provider, preset: undefined, timeoutMs: undefined }))) {
      chain.push(
        toAssignment(
          "hanlin_reviewer",
          "大副",
          "optional",
          reviewer.provider,
          reviewer.preset,
          reviewer.timeoutMs,
        ),
      );
    }

    if (workflow.audit.required) {
      chain.push(
        toAssignment(
          "menxia_auditor",
          "安全官",
          "required",
          route.auditTarget?.provider ?? workflow.audit.provider ?? route.finalArbiter ?? route.reviewers[0] ?? route.draftProvider,
          route.auditTarget?.preset,
          route.auditTarget?.timeoutMs,
        ),
      );
    }

    if (route.finalArbiter || route.finalArbiterTarget) {
      chain.push(
        toAssignment(
          "zhongshu_arbiter",
          "通讯官",
          "required",
          route.finalArbiterTarget?.provider ?? route.finalArbiter,
          route.finalArbiterTarget?.preset,
          route.finalArbiterTarget?.timeoutMs,
        ),
      );
    }

    if (route.executor) {
      chain.push(toAssignment("shangshu_executor", "轮机长", "required", route.executor));
    }

    if (taskType === "CODING") {
      chain.push(toAssignment("junji_implementer", "导航员", "required", "codex_runner"));
    }

    chain.push(toAssignment("sitian_monitor", "瞭望塔", "required"));
    return { chain };
  }
}
