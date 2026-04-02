import type {
  ArtifactType,
  SkillDefinition,
  SkillPackRecord,
  TaskIntent,
  TaskSkillSelection,
  TaskSubmission,
  TaskType,
  WorkflowMeta,
} from "./types";
import { normalizeWhitespace } from "./utils";

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    id: "summarize",
    packId: "knowledge",
    packName: "知识整理",
    packDescription: "负责总结、归纳、知识沉淀和上下文整理。",
    name: "总结",
    description: "输出简洁结论、摘要和结构化归纳。",
    enabled: true,
    weight: 0.55,
    intents: ["qa", "office_discussion", "doc", "ppt", "video"],
    keywords: ["总结", "概括", "摘要", "归纳"],
    resourceHints: ["short_answer"],
    toolHints: ["summary", "memory_write"],
    promptHints: ["先给结论，再给摘要。"],
    memoryLayers: ["episodic", "long_term"],
  },
  {
    id: "review_text",
    packId: "governance",
    packName: "治理审核",
    packDescription: "负责审查、风险把关、修订建议和质量控制。",
    name: "审校",
    description: "补充问题点、风险点、修订建议与质量把关。",
    enabled: true,
    weight: 0.9,
    intents: ["office_discussion", "doc", "ppt", "video", "coding"],
    keywords: ["审核", "审查", "复核", "review", "校对", "严谨"],
    resourceHints: ["review_prompt"],
    toolHints: ["audit", "approval"],
    promptHints: ["优先指出风险、边界和需要修订的地方。"],
    memoryLayers: ["working", "episodic"],
  },
  {
    id: "code_generate",
    packId: "coding_ops",
    packName: "代码执行",
    packDescription: "负责代码修改、本地执行、测试与工程交付。",
    name: "代码生成",
    description: "生成代码方案、实施步骤和 Codex handoff。",
    enabled: true,
    weight: 1,
    taskTypes: ["CODING"],
    intents: ["coding"],
    resourceHints: ["codex_bundle"],
    toolHints: ["filesystem", "terminal", "test"],
    promptHints: ["优先直接落地，不要只描述步骤。"],
    memoryLayers: ["working", "episodic"],
  },
  {
    id: "image_generation",
    packId: "visual_media",
    packName: "视觉媒体",
    packDescription: "负责图片、截图、海报、封面等视觉产物。",
    name: "图片出图",
    description: "整理图片意图、风格、负面约束和图像执行产物。",
    enabled: true,
    weight: 1,
    artifactTypes: ["image"],
    intents: ["image"],
    keywords: ["图片", "海报", "封面", "出图", "画一张"],
    resourceHints: ["image_prompt"],
    toolHints: ["image", "screenshot"],
    promptHints: ["需要图片时优先生成可回传的图像文件。"],
    memoryLayers: ["working", "episodic"],
  },
  {
    id: "image_analysis",
    packId: "visual_media",
    packName: "视觉媒体",
    packDescription: "负责图片、截图、海报、封面等视觉产物。",
    name: "图像分析",
    description: "识别图像内容、构图问题和风格建议。",
    enabled: true,
    weight: 0.7,
    intents: ["image"],
    keywords: ["识图", "图像分析", "看图", "图片分析"],
    resourceHints: ["vision"],
    toolHints: ["image", "vision"],
    promptHints: ["分析图片时补充构图、可读性和风格意见。"],
    memoryLayers: ["working", "episodic"],
  },
  {
    id: "deployment_script",
    packId: "coding_ops",
    packName: "代码执行",
    packDescription: "负责代码修改、本地执行、测试与工程交付。",
    name: "部署脚本",
    description: "生成部署命令、发布步骤和回滚建议。",
    enabled: true,
    weight: 0.95,
    taskTypes: ["CODING"],
    keywords: ["部署", "上线", "脚本", "发布", "回滚"],
    resourceHints: ["shell_script"],
    toolHints: ["terminal", "deploy"],
    promptHints: ["提供上线步骤时要包含回滚建议。"],
    memoryLayers: ["episodic", "long_term"],
  },
];

function includesAny(input: string, values: string[] | undefined): boolean {
  if (!values || values.length === 0) {
    return false;
  }
  return values.some((value) => input.includes(value));
}

function matchesIntent(intent: TaskIntent, candidates?: TaskIntent[]): boolean {
  return !candidates || candidates.length === 0 || candidates.includes(intent);
}

function matchesType(taskType: TaskType, candidates?: TaskType[]): boolean {
  return !candidates || candidates.length === 0 || candidates.includes(taskType);
}

function matchesArtifact(artifactType: ArtifactType, candidates?: ArtifactType[]): boolean {
  return !candidates || candidates.length === 0 || candidates.includes(artifactType);
}

function hasExplicitScope(values?: readonly unknown[]): boolean {
  return Boolean(values && values.length > 0);
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(definitions: SkillDefinition[] = BUILTIN_SKILLS) {
    this.replaceAll(definitions);
  }

  register(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill);
  }

  unregister(skillId: string): void {
    this.skills.delete(skillId);
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  listPacks(): SkillPackRecord[] {
    const packs = new Map<string, SkillPackRecord>();

    for (const skill of this.skills.values()) {
      const packId = skill.packId ?? `pack:${skill.id}`;
      const existing = packs.get(packId);
      if (!existing) {
        packs.set(packId, {
          id: packId,
          name: skill.packName ?? skill.name,
          description: skill.packDescription ?? skill.description,
          enabled: skill.enabled,
          skillIds: [skill.id],
          toolHints: [...new Set(skill.toolHints ?? [])],
          promptHints: [...new Set(skill.promptHints ?? [])],
          memoryLayers: [...new Set(skill.memoryLayers ?? [])],
        });
        continue;
      }

      existing.enabled = existing.enabled || skill.enabled;
      existing.skillIds.push(skill.id);
      existing.toolHints = [...new Set([...existing.toolHints, ...(skill.toolHints ?? [])])];
      existing.promptHints = [...new Set([...existing.promptHints, ...(skill.promptHints ?? [])])];
      existing.memoryLayers = [...new Set([...existing.memoryLayers, ...(skill.memoryLayers ?? [])])];
    }

    return [...packs.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  resolvePacksForSelection(selections: TaskSkillSelection[]): SkillPackRecord[] {
    const packs = new Map(this.listPacks().map((pack) => [pack.id, pack]));
    const selected = new Map<string, SkillPackRecord>();

    for (const selection of selections) {
      if (!selection.packId) {
        continue;
      }
      const pack = packs.get(selection.packId);
      if (pack) {
        selected.set(pack.id, pack);
      }
    }

    return [...selected.values()];
  }

  replaceAll(definitions: SkillDefinition[]): void {
    this.skills.clear();
    for (const definition of definitions) {
      this.skills.set(definition.id, definition);
    }
  }

  resolveForTask(input: {
    submission: TaskSubmission;
    taskType: TaskType;
    workflow: Pick<WorkflowMeta, "intent" | "artifactType" | "audit">;
  }): TaskSkillSelection[] {
    const normalizedInput = normalizeWhitespace(input.submission.input.toLowerCase());
    const requested = new Set(input.submission.requestedSkills ?? []);
    const selected: TaskSkillSelection[] = [];

    for (const skill of this.skills.values()) {
      if (!skill.enabled) {
        continue;
      }

      let score = 0;
      let reason = "matched_registry";
      let required = false;

      if (requested.has(skill.id)) {
        score += 1;
        required = true;
        reason = "requested_by_user";
      }

      if (hasExplicitScope(skill.taskTypes) && matchesType(input.taskType, skill.taskTypes)) {
        score += 0.25;
      }

      if (hasExplicitScope(skill.intents) && matchesIntent(input.workflow.intent, skill.intents)) {
        score += 0.3;
      }

      if (hasExplicitScope(skill.artifactTypes) && matchesArtifact(input.workflow.artifactType, skill.artifactTypes)) {
        score += 0.35;
      }

      if (includesAny(normalizedInput, skill.keywords)) {
        score += 0.45;
        reason = reason === "matched_registry" ? "prompt_keyword_match" : reason;
      }

      if (skill.id === "review_text" && input.workflow.audit.required) {
        score += 0.6;
        required = true;
        reason = "audit_guardrail";
      }

      if (score < 0.55 && !required) {
        continue;
      }

      selected.push({
        id: skill.id,
        weight: Number((score * skill.weight).toFixed(2)),
        reason,
        required,
        packId: skill.packId,
        packName: skill.packName,
      });
    }

    return selected.sort((left, right) => right.weight - left.weight);
  }
}
