import type { ProviderPromptRequest } from "@office-agent/core";
import type { SiteProfile } from "@office-agent/web-playwright";
import { buildQwenPrompt } from "./composer";

export const qwenSiteProfile: SiteProfile = {
  name: "qwen_web",
  providerHomePath: "/",
  buildPrompt(request: ProviderPromptRequest): string {
    return buildQwenPrompt(request);
  },
};
