import type { ProviderPromptRequest } from "@office-agent/core";
import type { SiteProfile } from "@office-agent/web-playwright";
import { buildGrokPrompt } from "./composer";

export const grokSiteProfile: SiteProfile = {
  name: "grok_web",
  providerHomePath: "/",
  buildPrompt(request: ProviderPromptRequest): string {
    return buildGrokPrompt(request);
  },
};
