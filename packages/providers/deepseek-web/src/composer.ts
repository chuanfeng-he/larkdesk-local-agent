import type { ProviderPromptRequest } from "@office-agent/core";

export function buildDeepSeekPrompt(request: ProviderPromptRequest): string {
  return [
    "你是本地优先办公智能体中的 DeepSeek 网页模型节点。",
    "请优先给出简洁结论，再补充最多 5 条可执行建议。",
    "如果网页需要重新登录、验证码或人工确认，请直接说明需要人工恢复。",
    "",
    request.prompt,
  ].join("\n");
}
