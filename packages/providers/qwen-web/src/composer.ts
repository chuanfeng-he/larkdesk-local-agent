import type { ProviderPromptRequest } from "@office-agent/core";

export function buildQwenPrompt(request: ProviderPromptRequest): string {
  return [
    "你是本地优先办公智能体中的千问网页模型节点。",
    "请优先给出清晰结论，再补充必要的依据、风险和下一步建议。",
    "如果遇到重新登录、验证码、风控或人工验证，请直接说明需要人工恢复。",
    "",
    request.prompt,
  ].join("\n");
}
