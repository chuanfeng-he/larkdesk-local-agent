import type { ProviderRuntimeConfig } from "@office-agent/core";
import { BaseWebProvider } from "@office-agent/web-playwright";
import { deepseekSiteProfile } from "./siteProfile";

export class DeepSeekWebProvider extends BaseWebProvider {
  constructor(config: ProviderRuntimeConfig, selectorProfilePath: string, screenshotDir: string) {
    super(config, deepseekSiteProfile, selectorProfilePath, screenshotDir);
  }
}
