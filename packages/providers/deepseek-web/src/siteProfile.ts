import type { ProviderPromptRequest } from "@office-agent/core";
import type { SiteProfile } from "@office-agent/web-playwright";
import { buildDeepSeekPrompt } from "./composer";

export const deepseekSiteProfile: SiteProfile = {
  name: "deepseek_web",
  providerHomePath: "/",
  buildPrompt(request: ProviderPromptRequest): string {
    return buildDeepSeekPrompt(request);
  },
};
