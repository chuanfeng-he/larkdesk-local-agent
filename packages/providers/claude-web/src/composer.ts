import type { ProviderPromptRequest } from "@office-agent/core";

export function buildClaudePrompt(request: ProviderPromptRequest): string {
  return [
    "你是本地优先办公智能体中的 Claude 网页模型节点。",
    "请偏向审稿、补充论证、澄清歧义，并给出更适合正式交付的答案。",
    "如果需要重新登录、验证码或人工验证，请直接说明需要人工恢复。",
    "",
    request.prompt,
  ].join("\n");
}
