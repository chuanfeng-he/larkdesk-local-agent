import type { ProviderPromptRequest } from "@office-agent/core";

export function buildDoubaoPrompt(request: ProviderPromptRequest): string {
  return request.prompt;
}
