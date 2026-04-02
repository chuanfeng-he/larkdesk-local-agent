import type { ProviderPromptRequest } from "@office-agent/core";
import type { SiteProfile } from "@office-agent/web-playwright";
import { buildDoubaoPrompt } from "./composer";

export const doubaoSiteProfile: SiteProfile = {
  name: "doubao_web",
  providerHomePath: "/",
  buildPrompt(request: ProviderPromptRequest): string {
    return buildDoubaoPrompt(request);
  },
};
