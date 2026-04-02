import type {
  ArtifactType,
  AuditTrigger,
  TaskBudget,
  TaskComplexity,
  TaskIntent,
  TaskQualityLevel,
  TaskRiskLevel,
  TaskSubmission,
  TaskTier,
  TaskType,
  WorkflowAuditPolicy,
} from "./types";
import { normalizeWhitespace } from "./utils";

const codingKeywords = [
  "代码",
  "编程",
  "codex",
  "调用codex",
  "用codex",
  "交给codex",
  "bug",
  "修复",
  "typescript",
  "node",
  "fastify",
  "prisma",
  "仓库",
  "repo",
  "test",
  "测试",
  "实现",
  "重构",
];

const complexKeywords = [
  "方案",
  "对比",
  "评审",
  "仲裁",
  "冲突",
  "复杂",
  "深入分析",
  "深度分析",
  "系统性",
  "完整方案",
  "多维度",
  "分步骤",
  "细化",
  "详尽",
  "详细",
  "架构",
  "review",
  "tradeoff",
  "多模型",
  "workflow",
];

const docKeywords = ["文档", "报告", "纪要", "方案文档", "prd", "proposal", "说明书"];
const pptKeywords = ["ppt", "slides", "演示稿", "汇报", "路演", "deck"];
const imageKeywords = [
  "图片",
  "图像",
  "照片",
  "相片",
  "头像",
  "壁纸",
  "插画",
  "表情包",
  "海报",
  "配图",
  "封面图",
  "画一张",
  "来一张",
  "生成图",
  "出图",
  "image",
];
const videoKeywords = ["视频", "短视频", "口播", "脚本", "分镜", "字幕", "video"];

const highBudgetKeywords = ["多 reviewer", "多评审", "多模型讨论", "充分讨论", "深入", "全面", "高预算", "深度思考", "专家审核"];
const lowBudgetKeywords = ["快速", "简单处理", "低成本", "低预算", "尽快", "一句话", "简单回答", "直接回答"];

const auditKeywords = ["审核", "审查", "复核", "校验", "把关", "严审", "review", "audit"];
const strictQualityKeywords = ["高质量", "正式", "发给领导", "发给客户", "可交付", "严谨", "上线版", "对外", "专业", "完整", "可直接发送"];
const highRiskKeywords = ["上线", "生产", "部署", "合同", "财务", "法务", "安全", "权限", "支付", "风控", "合规"];
const realtimeTimeKeywords = [
  "现在",
  "当前",
  "今天",
  "今日",
  "实时",
  "最新",
  "最近",
  "近期",
  "刚刚",
  "本周",
  "本月",
  "明天",
  "昨天",
];
const realtimeSourceKeywords = [
  "新闻",
  "消息",
  "热点",
  "公告",
  "通告",
  "通知",
  "规则",
  "政策",
  "活动",
  "开奖结果",
  "抽奖",
  "开奖",
  "发票",
  "云闪付",
  "官网",
  "app",
];
const realtimeDecisionKeywords = [
  "必须",
  "是否",
  "是不是",
  "能不能",
  "还在",
  "截止",
  "有效",
  "适用",
  "要求",
  "条件",
  "时间",
  "日期",
  "几点",
  "多久",
];
const docExtensionRegex = /\.docx?\b/i;
const docFormatHintPatterns = [
  /word格式/u,
  /word文档/u,
  /(?:输出|导出|生成|提供)(?:一份|一个)?\s*word/u,
  /(?:输出|导出|生成|提供)(?:一份|一个)?\s*docx/u,
  /(?:输出|导出|生成|提供)(?:一份|一个)?\s*doc(?!ker)/u,
  /docx格式/u,
  /doc格式/u,
  /(?:^|[\s(（【\[])(?:word|docx)(?:$|[\s)）】\].,，。:：；;!?？!]|版本|文档|格式)/iu,
];

function normalizeInput(input: string): string {
  return normalizeWhitespace(input.toLowerCase());
}

function countHits(input: string, keywords: string[]): number {
  return keywords.filter((keyword) => input.includes(keyword)).length;
}

function containsDocFormatHint(input: string): boolean {
  if (docKeywords.some((keyword) => input.includes(keyword))) {
    return true;
  }

  return docFormatHintPatterns.some((pattern) => pattern.test(input)) || docExtensionRegex.test(input);
}

export function hasRealtimeInfoNeed(input: string): boolean {
  const normalized = normalizeInput(input);
  const timeHits = countHits(normalized, realtimeTimeKeywords);
  const sourceHits = countHits(normalized, realtimeSourceKeywords);
  const decisionHits = countHits(normalized, realtimeDecisionKeywords);

  if (/(活动规则|最新消息|实时新闻|最新公告|最新政策|开奖时间|抽奖时间|报名时间)/u.test(normalized)) {
    return true;
  }

  if (timeHits >= 1 && sourceHits >= 1) {
    return true;
  }

  if (sourceHits >= 2) {
    return true;
  }

  if (sourceHits >= 1 && decisionHits >= 1) {
    return true;
  }

  return false;
}

export function classifyTask(submission: TaskSubmission): TaskType {
  if (submission.requestedType) {
    return submission.requestedType;
  }

  const input = normalizeInput(submission.input);

  if (codingKeywords.some((keyword) => input.includes(keyword))) {
    return "CODING";
  }

  if (complexKeywords.some((keyword) => input.includes(keyword))) {
    return "COMPLEX";
  }

  return "SIMPLE";
}

export function inferTaskIntent(submission: TaskSubmission): TaskIntent {
  if (submission.requestedIntent) {
    return submission.requestedIntent;
  }

  const input = normalizeInput(submission.input);

  if (codingKeywords.some((keyword) => input.includes(keyword))) {
    return "coding";
  }

  if (pptKeywords.some((keyword) => input.includes(keyword))) {
    return "ppt";
  }

  if (imageKeywords.some((keyword) => input.includes(keyword))) {
    return "image";
  }

  if (videoKeywords.some((keyword) => input.includes(keyword))) {
    return "video";
  }

  if (containsDocFormatHint(input)) {
    return "doc";
  }

  if (complexKeywords.some((keyword) => input.includes(keyword))) {
    return "office_discussion";
  }

  return "qa";
}

export function inferTaskBudget(submission: TaskSubmission): TaskBudget {
  if (submission.budget) {
    return submission.budget;
  }

  const input = normalizeInput(submission.input);

  if (highBudgetKeywords.some((keyword) => input.includes(keyword))) {
    return "high";
  }

  if (lowBudgetKeywords.some((keyword) => input.includes(keyword))) {
    return "low";
  }

  return "standard";
}

export function inferArtifactType(submission: TaskSubmission): ArtifactType {
  if (submission.artifactType) {
    return submission.artifactType;
  }

  const intent = inferTaskIntent(submission);
  if (intent === "doc") {
    return "doc";
  }
  if (intent === "ppt") {
    return "ppt";
  }
  if (intent === "image") {
    return "image";
  }
  if (intent === "video") {
    return "video";
  }
  return "none";
}

export function inferTaskQualityLevel(submission: TaskSubmission): TaskQualityLevel {
  if (submission.qualityLevel) {
    return submission.qualityLevel;
  }

  const input = normalizeInput(submission.input);
  if (strictQualityKeywords.some((keyword) => input.includes(keyword))) {
    return "strict";
  }
  if (inferTaskBudget(submission) === "high") {
    return "high";
  }
  if (inferTaskBudget(submission) === "low") {
    return "fast";
  }
  return "standard";
}

export function inferTaskRiskLevel(submission: TaskSubmission): TaskRiskLevel {
  if (submission.riskLevel) {
    return submission.riskLevel;
  }

  const input = normalizeInput(submission.input);
  const highHits = countHits(input, highRiskKeywords);
  if (highHits >= 2) {
    return "critical";
  }
  if (highHits >= 1) {
    return "high";
  }
  if (/客户|领导|对外|发布/.test(input)) {
    return "medium";
  }
  return "low";
}

export function inferComplexityScore(submission: TaskSubmission): number {
  if (submission.complexity === "easy") {
    return 0.25;
  }
  if (submission.complexity === "medium") {
    return 0.55;
  }
  if (submission.complexity === "hard") {
    return 0.85;
  }

  const input = normalizeInput(submission.input);
  const lengthScore = Math.min(input.length / 400, 1);
  const complexityHits = countHits(input, complexKeywords) * 0.12;
  const codingHits = countHits(input, codingKeywords) * 0.1;
  const artifactHits =
    (countHits(input, [...pptKeywords, ...imageKeywords, ...videoKeywords]) + (containsDocFormatHint(input) ? 1 : 0)) * 0.08;
  const score = Math.min(0.15 + lengthScore + complexityHits + codingHits + artifactHits, 1);
  return Number(score.toFixed(2));
}

export function inferTaskComplexity(submission: TaskSubmission): TaskComplexity {
  if (submission.complexity) {
    return submission.complexity;
  }

  const score = inferComplexityScore(submission);
  if (score >= 0.75) {
    return "hard";
  }
  if (score >= 0.45) {
    return "medium";
  }
  return "easy";
}

export function inferAuditPolicy(submission: TaskSubmission): WorkflowAuditPolicy {
  const triggers: AuditTrigger[] = [];
  const input = normalizeInput(submission.input);
  const qualityLevel = inferTaskQualityLevel(submission);
  const riskLevel = inferTaskRiskLevel(submission);
  const complexityScore = inferComplexityScore(submission);
  const artifactType = inferArtifactType(submission);

  const requested = Boolean(submission.requiresAudit) || auditKeywords.some((keyword) => input.includes(keyword));
  if (requested) {
    triggers.push("prompt_required");
  }

  if (qualityLevel === "strict" || qualityLevel === "high") {
    triggers.push("quality_gate");
  }

  if (complexityScore >= 0.7) {
    triggers.push("complexity_threshold");
  }

  if (riskLevel === "high" || riskLevel === "critical") {
    triggers.push("risk_threshold");
  }

  if (artifactType !== "none") {
    triggers.push("artifact_guardrail");
  }

  return {
    requested,
    required: triggers.length > 0,
    triggers,
    strategy: "structured_gate",
    maxRevisionRounds: riskLevel === "critical" ? 2 : 1,
    maxAttempts: artifactType !== "none" || requested ? 4 : 3,
  };
}

/**
 * Infer the execution tier for a task submission.
 *
 * T0: handled by resolveLocalSimpleShortcut (not here — always checked first)
 * T1: simple Q&A suitable for fast API provider (Gemini API)
 * T2: single web-model tasks (artifacts, moderate complexity)
 * T3: multi-model review tasks (office discussion, high budget/risk)
 */
export function inferTier(submission: TaskSubmission): TaskTier {
  const taskType = classifyTask(submission);
  const input = normalizeInput(submission.input);
  const complexityScore = inferComplexityScore(submission);
  const budget = inferTaskBudget(submission);
  const riskLevel = inferTaskRiskLevel(submission);
  const artifactType = inferArtifactType(submission);
  const intent = inferTaskIntent(submission);
  const realtimeInfoNeed = hasRealtimeInfoNeed(submission.input);

  // T3: multi-model review needed
  if (
    budget === "high" ||
    intent === "office_discussion" ||
    highBudgetKeywords.some((kw) => input.includes(kw)) ||
    (taskType === "COMPLEX" && complexityScore >= 0.7)
  ) {
    return "T3";
  }

  // T2: has artifacts, or moderate complexity, or coding, or COMPLEX type
  if (
    artifactType !== "none" ||
    taskType === "CODING" ||
    taskType === "COMPLEX" ||
    complexityScore >= 0.3 ||
    realtimeInfoNeed
  ) {
    return "T2";
  }

  // T1: simple, short, low-risk Q&A — perfect for API
  if (
    taskType === "SIMPLE" &&
    input.length < 200 &&
    riskLevel === "low" &&
    (budget === "low" || budget === "standard")
  ) {
    return "T1";
  }

  // Default to T2 for safety
  return "T2";
}
