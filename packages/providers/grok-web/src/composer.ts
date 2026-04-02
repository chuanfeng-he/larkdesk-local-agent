import type { ProviderPromptRequest } from "@office-agent/core";

export function buildGrokPrompt(request: ProviderPromptRequest): string {
  return [
    "你是本地优先办公智能体中的 Grok 网页模型节点。",
    "请偏向补充视角、风险提醒和更直接的结论，但不要泄露任何敏感信息。",
    "如果遇到重新登录、验证码、风控或人工验证，请直接说明需要人工恢复。",
    "",
    request.prompt,
  ].join("\n");
}
