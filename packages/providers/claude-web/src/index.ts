import type { ProviderRuntimeConfig } from "@office-agent/core";
import { BaseWebProvider } from "@office-agent/web-playwright";
import { claudeSiteProfile } from "./siteProfile";

export class ClaudeWebProvider extends BaseWebProvider {
  constructor(config: ProviderRuntimeConfig, selectorProfilePath: string, screenshotDir: string) {
    super(config, claudeSiteProfile, selectorProfilePath, screenshotDir);
  }
}
