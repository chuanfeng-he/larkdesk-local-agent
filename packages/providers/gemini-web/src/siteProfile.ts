import type { ProviderPromptRequest } from "@office-agent/core";
import type { SiteProfile } from "@office-agent/web-playwright";
import { buildGeminiPrompt } from "./composer";

export const geminiSiteProfile: SiteProfile = {
  name: "gemini_web",
  providerHomePath: "/app",
  buildPrompt(request: ProviderPromptRequest): string {
    return buildGeminiPrompt(request);
  },
};
