import type {
  AuditDecision,
  AuditResult,
  TaskRiskLevel,
  TaskRecord,
  WorkflowAuditPolicy,
  WorkflowMeta,
} from "./types";
import { summarizeText } from "./utils";

const DECISION_PATTERNS: Array<{ decision: AuditDecision; patterns: RegExp[] }> = [
  {
    decision: "reject",
    patterns: [/结论[:：]\s*reject/i, /未通过/, /驳回/, /reject/i],
  },
  {
    decision: "revise_required",
    patterns: [/结论[:：]\s*revise_required/i, /需要修订/, /请修改/, /revise_required/i],
  },
  {
    decision: "pass",
    patterns: [/结论[:：]\s*pass/i, /通过/, /可交付/, /pass/i],
  },
];

const RISK_PATTERNS: Array<{ risk: TaskRiskLevel; patterns: RegExp[] }> = [
  { risk: "critical", patterns: [/critical/i, /严重/, /高危/] },
  { risk: "high", patterns: [/high/i, /高风险/, /较高风险/] },
  { risk: "medium", patterns: [/medium/i, /中风险/] },
  { risk: "low", patterns: [/low/i, /低风险/] },
];

function parseListSection(title: string, input: string): string[] {
  const matcher = new RegExp(`${title}[:：]\\s*([\\s\\S]*?)(?:\\n(?:建议|问题|风险级别|结论)[:：]|$)`, "i");
  const match = input.match(matcher);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(/\n+/)
    .map((line) => line.replace(/^[-*0-9.、\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

export class AuditEngine {
  shouldAudit(workflow: WorkflowMeta): boolean {
    return workflow.audit.required;
  }

  buildAuditPrompt(input: {
    task: TaskRecord;
    workflow: WorkflowMeta;
    currentAnswer: string;
    draftProvider: string;
  }): string {
    const docTaskGuardrails = buildDocAuditGuardrails(input.task, input.workflow);
    const currentAnswer =
      input.workflow.intent === "doc" ? input.currentAnswer.trim() : summarizeText(input.currentAnswer, 1_200);
    return [
      "你是安全官，负责最后质量把关。",
      "请检查候选答复是否满足原需求、是否存在事实/执行/合规风险、是否适合直接交付。",
      ...(input.workflow.intent === "doc" ? ["", ...docTaskGuardrails] : []),
      "",
      `任务类型：${input.task.type}`,
      `任务意图：${input.workflow.intent}`,
      `风险等级：${input.workflow.riskLevel}`,
      `复杂度分：${input.workflow.complexityScore}`,
      `原始需求：${summarizeText(input.task.normalizedInput, 700)}`,
      `当前候选答案：[${input.draftProvider}] ${currentAnswer}`,
      "",
      "请严格按以下结构输出：",
      "结论：pass / revise_required / reject",
      "问题：",
      "- 最多 5 条",
      "建议：",
      "- 最多 5 条",
      "风险级别：low / medium / high / critical",
      "",
      "规则：",
      "- 如果内容可以直接交付，输出 pass",
      "- 如果内容方向对但还需修正，输出 revise_required",
      "- 如果内容明显偏题、风险高或不适合交付，输出 reject",
      "- 如果你在“问题”或“建议”中写了任何需要落实的修订项，就不要输出 pass，必须输出 revise_required",
      "- 不要输出思维过程",
    ].join("\n");
  }

  buildRevisionPrompt(input: {
    task: TaskRecord;
    workflow: WorkflowMeta;
    currentAnswer: string;
    auditResult: AuditResult;
  }): string {
    const docTaskGuardrails = buildDocAuditGuardrails(input.task, input.workflow);
    const currentAnswer =
      input.workflow.intent === "doc" ? input.currentAnswer.trim() : summarizeText(input.currentAnswer, 1_100);
    const issueText = input.auditResult.issues.length > 0 ? input.auditResult.issues.map((item) => `- ${item}`).join("\n") : "- 无";
    const suggestionText =
      input.auditResult.suggestions.length > 0
        ? input.auditResult.suggestions.map((item) => `- ${item}`).join("\n")
        : "- 保持原方向但修正表达";

    return [
      "你需要根据安全官审核意见修订最终答复。",
      ...(input.workflow.intent === "doc" ? [...docTaskGuardrails, ""] : []),
      `原始需求：${summarizeText(input.task.normalizedInput, 700)}`,
      `当前答复：${currentAnswer}`,
      "",
      "审核问题：",
      issueText,
      "",
      "修订建议：",
      suggestionText,
      "",
      "请输出修订后的最终答案，要求：",
      "- 直接面向最终用户",
      "- 优先修正审核指出的问题",
      "- 不要回显审核模板",
      "- 保持简洁清晰",
      ...(input.workflow.intent === "doc"
        ? [
            "- 只能输出最终文档正文本体",
            "- 不允许输出“结论”“建议”“审核说明”“补充说明”“可执行建议”“待确认清单前言”等过程性话术",
            "- 不允许在正文前加任何解释性导语或审核结论",
            "- 如果需要保留待补字段，只能以内嵌占位形式写在文档对应位置，不能另起过程说明",
          ]
        : []),
    ].join("\n");
  }

  parseAuditResult(outputText: string, fallbackRiskLevel: TaskRiskLevel): AuditResult {
    const trimmed = outputText.trim();
    const decision =
      DECISION_PATTERNS.find((entry) => entry.patterns.some((pattern) => pattern.test(trimmed)))?.decision ?? "revise_required";
    const riskLevel =
      RISK_PATTERNS.find((entry) => entry.patterns.some((pattern) => pattern.test(trimmed)))?.risk ?? fallbackRiskLevel;

    return {
      decision,
      riskLevel,
      issues: parseListSection("问题", trimmed),
      suggestions: parseListSection("建议", trimmed),
      rawText: trimmed,
    };
  }

  decorateAuditPolicy(workflow: WorkflowMeta, provider?: string): WorkflowMeta {
    const maxRevisionRounds = resolveAuditRevisionRounds(workflow);
    const maxAttempts = resolveAuditAttemptLimit(workflow);
    const audit: WorkflowAuditPolicy = {
      ...workflow.audit,
      provider: provider ?? workflow.audit.provider,
      maxRevisionRounds,
      maxAttempts,
    };

    return {
      ...workflow,
      audit,
    };
  }
}

function resolveAuditRevisionRounds(workflow: WorkflowMeta): number {
  let rounds = workflow.audit.maxRevisionRounds;

  if (workflow.audit.required) {
    rounds = Math.max(rounds, 1);
  }

  if (workflow.intent === "doc" || workflow.artifactType !== "none" || workflow.complexity === "hard") {
    rounds = Math.max(rounds, 2);
  }

  if (
    workflow.riskLevel === "high" ||
    workflow.riskLevel === "critical" ||
    workflow.qualityLevel === "high" ||
    workflow.qualityLevel === "strict"
  ) {
    rounds = Math.max(rounds, 3);
  }

  return rounds;
}

function resolveAuditAttemptLimit(workflow: WorkflowMeta): number {
  let attempts = Math.max(1, workflow.audit.maxAttempts ?? 4);

  if (workflow.intent === "doc" || workflow.artifactType !== "none") {
    attempts = Math.max(attempts, 5);
  }

  if (
    workflow.riskLevel === "high" ||
    workflow.riskLevel === "critical" ||
    workflow.qualityLevel === "strict"
  ) {
    attempts = Math.max(attempts, 6);
  }

  return attempts;
}

function buildDocAuditGuardrails(task: TaskRecord, workflow: WorkflowMeta): string[] {
  if (workflow.intent !== "doc") {
    return [];
  }

  return [
    "审核主体必须固定为“本地优先办公智能体系统”整体，而不是当前审核模型节点自己。",
    "如果原需求出现“你现在的架构”“你当前的架构”，统一解释为整个本地优先办公智能体系统的架构。",
    "如果候选答案把主体写成某个单独模型节点、某个 provider、或当前审核模型自己，应判为需要修订或驳回。",
    "如果候选答案出现“无法生成 Word/docx”“请复制到 Word”“需要手动排版”等表述，应判为需要修订或驳回。",
    "本阶段审核对象是文档正文草稿，实际 .docx 文件由后续执行器生成；不要仅因为当前输入还是纯文本草稿、尚未真正产出文件，就判定为不合格。",
    "如果候选答案编造了日期、版本号、客户端形态、API Key 管理方式、部署形态等未给定事实，应判为需要修订或驳回。",
    "如果用户没有提供版本号、日期、密级、供应商名单等元数据，候选答案可以省略这些字段；不要因为缺少这类未提供元数据而单独驳回。",
    "如果正文质量达标，不要要求模型在审核阶段先生成实际 docx 文件，也不要要求向用户再次确认后再生成。",
    `用户原始需求：${summarizeText(task.normalizedInput, 700)}`,
  ];
}
