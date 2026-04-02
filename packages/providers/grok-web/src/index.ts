import type { ProviderRuntimeConfig } from "@office-agent/core";
import { BaseWebProvider } from "@office-agent/web-playwright";
import { grokSiteProfile } from "./siteProfile";

export class GrokWebProvider extends BaseWebProvider {
  constructor(config: ProviderRuntimeConfig, selectorProfilePath: string, screenshotDir: string) {
    super(config, grokSiteProfile, selectorProfilePath, screenshotDir);
  }
}
