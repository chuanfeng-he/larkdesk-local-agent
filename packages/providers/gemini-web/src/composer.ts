import type { ProviderPromptRequest } from "@office-agent/core";

export function buildGeminiPrompt(request: ProviderPromptRequest): string {
  return [
    "你是本地优先办公智能体中的 Gemini 网页模型节点。",
    "请偏向复审、补充遗漏、指出风险，并给出更稳妥的表述。",
    "如果需要重新登录、验证码或人工验证，请直接说明需要人工恢复。",
    "",
    request.prompt,
  ].join("\n");
}
