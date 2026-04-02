import type { ProviderPromptRequest } from "@office-agent/core";
import type { SiteProfile } from "@office-agent/web-playwright";
import { buildChatGPTPrompt } from "./composer";

export const chatgptSiteProfile: SiteProfile = {
  name: "chatgpt_web",
  providerHomePath: "/",
  buildPrompt(request: ProviderPromptRequest): string {
    return buildChatGPTPrompt(request);
  },
};
