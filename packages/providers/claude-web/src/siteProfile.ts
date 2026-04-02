import type { ProviderPromptRequest } from "@office-agent/core";
import type { SiteProfile } from "@office-agent/web-playwright";
import { buildClaudePrompt } from "./composer";

export const claudeSiteProfile: SiteProfile = {
  name: "claude_web",
  providerHomePath: "/new",
  buildPrompt(request: ProviderPromptRequest): string {
    return buildClaudePrompt(request);
  },
};
