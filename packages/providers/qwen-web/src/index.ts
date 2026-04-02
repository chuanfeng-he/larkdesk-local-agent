import type { ProviderRuntimeConfig } from "@office-agent/core";
import { BaseWebProvider } from "@office-agent/web-playwright";
import { qwenSiteProfile } from "./siteProfile";

export class QwenWebProvider extends BaseWebProvider {
  constructor(config: ProviderRuntimeConfig, selectorProfilePath: string, screenshotDir: string) {
    super(config, qwenSiteProfile, selectorProfilePath, screenshotDir);
  }
}
