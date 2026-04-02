import type { ProviderRuntimeConfig } from "@office-agent/core";
import { BaseWebProvider } from "@office-agent/web-playwright";
import { chatgptSiteProfile } from "./siteProfile";

export class ChatGPTWebProvider extends BaseWebProvider {
  constructor(config: ProviderRuntimeConfig, selectorProfilePath: string, screenshotDir: string) {
    super(config, chatgptSiteProfile, selectorProfilePath, screenshotDir);
  }
}

