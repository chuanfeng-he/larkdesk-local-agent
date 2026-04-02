import { sleep, type ProviderRuntimeConfig, type SessionState } from "@office-agent/core";
import { BaseWebProvider } from "@office-agent/web-playwright";
import { geminiSiteProfile } from "./siteProfile";

export class GeminiWebProvider extends BaseWebProvider {
  constructor(config: ProviderRuntimeConfig, selectorProfilePath: string, screenshotDir: string) {
    super(config, geminiSiteProfile, selectorProfilePath, screenshotDir);
  }

  override async ensureSession(): Promise<SessionState> {
    const result = await Promise.race([
      super.ensureSession(),
      sleep(15_000).then(
        () =>
          ({
            ok: false,
            requiresManualLogin: true,
            detail:
              "gemini_web session check timed out. Gemini may be stuck on a risk-control, consent, or recovery page and needs manual recovery.",
          }) satisfies SessionState,
      ),
    ]);

    return result;
  }
}
