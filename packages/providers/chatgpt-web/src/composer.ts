import type { ProviderPromptRequest } from "@office-agent/core";

export function buildChatGPTPrompt(request: ProviderPromptRequest): string {
  return [
    "请作为本地优先办公智能体中的一个网页模型节点来回答。",
    "回答要简洁、结构化，并在必要时给出可执行建议。",
    "如果你发现自己需要登录、验证码或人工验证，请明确说无法继续并提示人工恢复。",
    "",
    request.prompt,
  ].join("\n");
}

