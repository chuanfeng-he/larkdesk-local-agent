import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AbstractProviderAdapter } from "@office-agent/core";
import type {
  ProviderCompletion,
  ProviderHealth,
  ProviderPromptRequest,
  ProviderPresetUiAction,
  ProviderRunHandle,
  ProviderPresetUiMode,
  ProviderRuntimeConfig,
  SessionState,
} from "@office-agent/core";
import { sleep, summarizeText } from "@office-agent/core";
import type { BrowserContext, Page } from "playwright";
import { chromium, firefox } from "playwright";
import YAML from "yaml";

export interface SelectorProfile {
  promptTextarea: string[];
  submitButton?: string[];
  responseBlocks: string[];
  generationStopButtons?: string[];
  allowCompletionWhileGenerationStable?: boolean;
  stableTicksRequired?: number;
  stableTicksWhileGenerating?: number;
  rejectPromptEcho?: boolean;
  promptEchoMinExtraChars?: number;
  loggedInMarkers?: string[];
  loginButtons?: string[];
  blockedUrlPatterns?: string[];
  blockedTextPatterns?: string[];
  sessionDetectionTimeoutMs?: number;
  preferKeyboardSubmit?: boolean;
}

export interface SiteProfile {
  name: string;
  providerHomePath?: string;
  buildPrompt?(request: ProviderPromptRequest): string;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export abstract class BaseWebProvider extends AbstractProviderAdapter {
  readonly kind = "web" as const;
  private contextPromise: Promise<BrowserContext> | null = null;
  private lastPage: Page | null = null;
  private lastSessionValidatedAt = 0;

  constructor(
    config: ProviderRuntimeConfig,
    protected readonly siteProfile: SiteProfile,
    protected readonly selectorProfilePath: string,
    protected readonly screenshotDir: string,
  ) {
    super(config.name, config);
  }

  protected async loadSelectors(): Promise<SelectorProfile> {
    const content = await readFile(this.selectorProfilePath, "utf8");
    return YAML.parse(content) as SelectorProfile;
  }

  protected getActivePage(): Page | null {
    return this.lastPage;
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.config.enabled) {
      return {
        provider: this.name,
        status: "disabled",
        detail: "Provider disabled by configuration.",
        checkedAt: new Date(),
      };
    }

    try {
      const session = await this.ensureSession();
      return {
        provider: this.name,
        status: session.requiresManualLogin ? session.failureKind ?? "needs_manual_login" : "available",
        detail: session.detail,
        checkedAt: new Date(),
        recoveryHint: session.requiresManualLogin ? this.manualRecoveryHint() : undefined,
      };
    } catch (error) {
      const failureKind = classifyProviderFailure(error instanceof Error ? error.message : String(error));
      return {
        provider: this.name,
        status: failureKind ?? "unhealthy",
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date(),
        recoveryHint: this.manualRecoveryHint(),
      };
    }
  }

  async ensureSession(): Promise<SessionState> {
    if (!this.config.enabled) {
      return {
        ok: false,
        detail: "Provider disabled.",
      };
    }

    if (this.hasFreshValidatedSession()) {
      return {
        ok: true,
        detail: `${this.name} session is reusable.`,
      };
    }

    const selectors = await this.loadSelectors();
    const { page } = await this.openSession();
    const canReuseCurrentPage = await this.pageHasPromptReady(page, selectors);
    if (!canReuseCurrentPage) {
      await this.gotoWithAbortTolerance(page, this.config.baseUrl ?? "about:blank");
    }

    const blockedReason = await this.detectBlockedReason(page, selectors);
    if (blockedReason) {
      this.lastSessionValidatedAt = 0;
      return {
        ok: false,
        requiresManualLogin: true,
        failureKind: "needs_manual_login",
        detail: blockedReason,
      };
    }

    const loggedIn = await this.detectLoggedIn(page, selectors);
    if (!loggedIn) {
      this.lastSessionValidatedAt = 0;
      return {
        ok: false,
        requiresManualLogin: true,
        failureKind: "needs_manual_login",
        detail: `${this.name} login is missing or expired.`,
      };
    }

    this.lastSessionValidatedAt = Date.now();
    return {
      ok: true,
      detail: `${this.name} session is reusable.`,
    };
  }

  async sendPrompt(request: ProviderPromptRequest): Promise<ProviderRunHandle> {
    return this.schedule(async () => {
      return this.runWithRetry(async () => {
        const selectors = await this.loadSelectors();
        const { page } = await this.openSession();
        const timeoutMs = this.resolveTimeout(request);
        const canReuseCurrentPage = await this.pageHasPromptReady(page, selectors);
        if (!this.hasFreshValidatedSession() && !canReuseCurrentPage) {
          await this.gotoWithAbortTolerance(page, this.config.baseUrl ?? "about:blank");
        }

        await this.applyPreset(request);
        const promptText = this.siteProfile.buildPrompt?.(request) ?? request.prompt;
        await this.waitForAnySelector(page, selectors.promptTextarea, selectors.sessionDetectionTimeoutMs ?? 0);
        const responseBaseline = await this.captureLatestResponseSnapshot(page, selectors.responseBlocks);
        await this.focusAndFill(page, selectors.promptTextarea, promptText, timeoutMs);
        await this.submitPrompt(page, selectors, timeoutMs);

        return {
          provider: this.name,
          startedAt: new Date(),
          meta: {
            selectors,
            responseBaseline,
            promptText,
            execution: request.execution,
          },
        };
      });
    });
  }

  async waitForCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion> {
    const selectors = (handle.meta?.selectors ?? {}) as SelectorProfile;
    const responseBaseline = handle.meta?.responseBaseline as ResponseSnapshot | undefined;
    const promptText = (handle.meta?.promptText as string | undefined) ?? "";
    const page = this.lastPage;

    if (!page) {
      throw new Error(`${this.name} page session was not initialized.`);
    }

    await this.waitForStableResponse(page, selectors, responseBaseline, promptText, this.resolveTimeoutFromMeta(handle.meta));

    return {
      provider: handle.provider,
      completedAt: new Date(),
      meta: {
        selectors,
        promptText,
        execution: handle.meta?.execution,
      },
    };
  }

  async extractAnswer(completion: ProviderCompletion): Promise<{
    provider: string;
    outputText: string;
    summary: string;
    meta?: Record<string, unknown>;
  }> {
    const selectors = (completion.meta?.selectors ?? {}) as SelectorProfile;
    const page = this.lastPage;

    if (!page) {
      throw new Error(`${this.name} page session was not initialized.`);
    }

    const outputText = await this.extractLatestResponse(page, selectors.responseBlocks);
    return {
      provider: this.name,
      outputText,
      summary: summarizeText(outputText, 280),
      meta: {
        baseUrl: this.config.baseUrl,
      },
    };
  }

  async screenshotOnFailure(taskId: string, _error: Error): Promise<string | undefined> {
    if (!this.lastPage) {
      return undefined;
    }

    await mkdir(this.screenshotDir, { recursive: true });
    const filePath = resolve(this.screenshotDir, `${this.name}-${taskId}-${Date.now()}.png`);
    await this.lastPage.screenshot({
      path: filePath,
      fullPage: true,
    });
    return filePath;
  }

  manualRecoveryHint(): string {
    return `请使用独立 profile ${this.config.profileDir ?? ""} 手动登录 ${this.name}，不要使用主浏览器默认 profile，也不要尝试绕过验证码。`;
  }

  async close(): Promise<void> {
    const context = await this.contextPromise?.catch(() => null);
    await context?.close();
    this.contextPromise = null;
    this.lastPage = null;
  }

  protected async extractLatestResponse(page: Page, selectors: string[]): Promise<string> {
    const snapshot = await this.captureLatestResponseSnapshot(page, selectors);
    if (snapshot) {
      return snapshot.text;
    }

    throw new Error(`${this.name} could not extract any response text.`);
  }

  private async openSession(): Promise<BrowserSession> {
    const context = await this.getContext();
    const page = this.pickBestPage(context.pages()) ?? (await context.newPage());
    this.lastPage = page;
    return {
      context,
      page,
    };
  }

  private pickBestPage(pages: Page[]): Page | null {
    if (pages.length === 0) {
      return null;
    }

    const baseUrl = this.config.baseUrl;
    if (!baseUrl) {
      return pages[0] ?? null;
    }

    let base: URL | null = null;
    try {
      base = new URL(baseUrl);
    } catch {
      return pages[0] ?? null;
    }

    const preferredPath = this.siteProfile.providerHomePath ?? (base.pathname || "/");
    const preferredPrefix = new URL(preferredPath, base.origin).toString();

    const exactMatch = pages.find((candidate) => candidate.url().startsWith(preferredPrefix));
    if (exactMatch) {
      return exactMatch;
    }

    const sameOrigin = pages.find((candidate) => {
      try {
        return new URL(candidate.url()).origin === base.origin;
      } catch {
        return false;
      }
    });
    if (sameOrigin) {
      return sameOrigin;
    }

    const webPage = pages.find((candidate) => {
      const url = candidate.url();
      return Boolean(url) && !url.startsWith("about:") && !url.startsWith("edge://");
    });
    return webPage ?? pages[0] ?? null;
  }

  private async gotoWithAbortTolerance(page: Page, targetUrl: string): Promise<void> {
    await page
      .goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.resolveTimeout(),
      })
      .catch((error: unknown) => {
        const currentUrl = typeof page.url === "function" ? page.url() : "";
        if (targetUrl !== "about:blank" && currentUrl.startsWith(targetUrl)) {
          return null;
        }

        throw error;
      });
  }

  private async getContext(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.createContext().catch((error) => {
        this.contextPromise = null;
        throw error;
      });
    }

    return this.contextPromise;
  }

  private async createContext(): Promise<BrowserContext> {
    if (this.config.mode === "cdp") {
      if (this.config.browser === "firefox") {
        throw new Error(`${this.name} Firefox does not support the configured CDP mode in this project.`);
      }

      if (!this.config.cdpEndpoint) {
        throw new Error(`${this.name} cdpEndpoint is required in CDP mode.`);
      }

      const browser = await chromium.connectOverCDP(this.config.cdpEndpoint);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      await this.applyDomainAllowlist(context);
      return context;
    }

    if (!this.config.profileDir) {
      throw new Error(`${this.name} profileDir is required in persistent mode.`);
    }

    await mkdir(this.config.profileDir, { recursive: true });
    const browserType = this.config.browser === "firefox" ? firefox : chromium;
    const context = await browserType.launchPersistentContext(
      this.config.profileDir,
      this.config.browser === "firefox"
        ? {
            headless: this.config.headless,
          }
        : {
            headless: this.config.headless,
            channel: this.config.browserChannel ?? "chromium",
          },
    );
    await this.applyDomainAllowlist(context);
    return context;
  }

  private async applyDomainAllowlist(context: BrowserContext): Promise<void> {
    const allowedDomains = this.config.allowedDomains;
    await context.route("**/*", async (route) => {
      const url = route.request().url();

      if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) {
        await route.continue();
        return;
      }

      const hostname = new URL(url).hostname;
      const allowed = allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
      if (!allowed) {
        await route.abort();
        return;
      }

      await route.continue();
    });
  }

  private async detectLoggedIn(page: Page, selectors: SelectorProfile): Promise<boolean> {
    const deadline = Date.now() + (selectors.sessionDetectionTimeoutMs ?? 2_000);

    while (Date.now() < deadline) {
      let sawLoggedInMarker = false;
      for (const selector of selectors.loggedInMarkers ?? []) {
        if (await page.locator(selector).count()) {
          sawLoggedInMarker = true;
        }
      }

      let sawLoginButton = false;
      for (const selector of selectors.loginButtons ?? []) {
        if (await page.locator(selector).count()) {
          sawLoginButton = true;
        }
      }

      if (sawLoggedInMarker && !sawLoginButton) {
        return true;
      }

      if (sawLoginButton) {
        await sleep(500);
        continue;
      }

      await sleep(250);
    }

    let sawLoggedInMarker = false;
    for (const selector of selectors.loggedInMarkers ?? []) {
      if (await page.locator(selector).count()) {
        sawLoggedInMarker = true;
      }
    }

    let sawLoginButton = false;
    for (const selector of selectors.loginButtons ?? []) {
      if (await page.locator(selector).count()) {
        sawLoginButton = true;
      }
    }

    return sawLoggedInMarker && !sawLoginButton;
  }

  private async detectBlockedReason(page: Page, selectors: SelectorProfile): Promise<string | null> {
    const currentUrl = page.url();
    for (const pattern of selectors.blockedUrlPatterns ?? []) {
      if (currentUrl.includes(pattern)) {
        return `${this.name} requires manual recovery because the provider redirected to a blocked page: ${currentUrl}`;
      }
    }

    const bodyText = ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 4000);
    for (const pattern of selectors.blockedTextPatterns ?? []) {
      if (bodyText.includes(pattern)) {
        return `${this.name} requires manual recovery because the provider is showing a blocked/risk-control page.`;
      }
    }

    return null;
  }

  private async focusAndFill(page: Page, selectors: string[], text: string, timeoutMs: number): Promise<void> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        continue;
      }

      await locator.click({
        timeout: timeoutMs,
      });

      try {
        await locator.fill(text, {
          timeout: timeoutMs,
        });
        return;
      } catch {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.type(text, {
          delay: 5,
        });
        return;
      }
    }

    throw new Error(`${this.name} could not find prompt textarea.`);
  }

  private async waitForAnySelector(page: Page, selectors: string[], timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) {
      return;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        if ((await page.locator(selector).count()) > 0) {
          return;
        }
      }

      await sleep(250);
    }
  }

  private async pageHasPromptReady(page: Page, selectors: SelectorProfile): Promise<boolean> {
    const blockedReason = await this.detectBlockedReason(page, selectors);
    if (blockedReason) {
      return false;
    }

    for (const selector of selectors.promptTextarea) {
      if ((await page.locator(selector).count().catch(() => 0)) > 0) {
        return true;
      }
    }

    return false;
  }

  private async submitPrompt(page: Page, selectors: SelectorProfile, timeoutMs: number): Promise<void> {
    const promptBeforeSubmit = await this.capturePromptInputText(page, selectors.promptTextarea);

    if (selectors.preferKeyboardSubmit) {
      await page.keyboard.press("Enter");
      const started = await this.waitForSubmissionStart(page, selectors, promptBeforeSubmit);
      if (started) {
        return;
      }
    }

    await sleep(350);

    for (const selector of selectors.submitButton ?? []) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        const disabled = await this.isSubmitControlDisabled(candidate);
        if (!visible || disabled) {
          continue;
        }

        await candidate.click({
          timeout: timeoutMs,
        });

        const started = await this.waitForSubmissionStart(page, selectors, promptBeforeSubmit);
        if (started) {
          return;
        }
      }
    }

    await page.keyboard.press("Enter");
    const started = await this.waitForSubmissionStart(page, selectors, promptBeforeSubmit);
    if (started) {
      return;
    }

    throw new Error(`${this.name} submitted the prompt but the page did not start generating a response.`);
  }

  private async waitForStableResponse(
    page: Page,
    selectors: SelectorProfile,
    baseline?: ResponseSnapshot,
    promptText = "",
    timeoutMs = this.resolveTimeout(),
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastText = "";
    let stableTicks = 0;
    const stableTicksRequired = selectors.stableTicksRequired ?? 2;
    const stableTicksWhileGenerating = selectors.stableTicksWhileGenerating ?? Math.max(stableTicksRequired + 4, 8);

    while (Date.now() < deadline) {
      const snapshot = await this.captureLatestResponseSnapshot(page, selectors.responseBlocks).catch(() => null);
      const text = snapshot?.text ?? "";
      const isNewResponse = this.isNewResponseSnapshot(snapshot, baseline);
      const promptEcho = this.isLikelyPromptEcho(text, promptText, selectors);
      const generationActive = await this.hasVisibleSelector(page, selectors.generationStopButtons ?? []);

      if (text && text === lastText) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
        lastText = text;
      }

      if (text && isNewResponse && !promptEcho && !generationActive && stableTicks >= stableTicksRequired) {
        return;
      }

      if (
        text &&
        isNewResponse &&
        !promptEcho &&
        generationActive &&
        selectors.allowCompletionWhileGenerationStable &&
        stableTicks >= stableTicksWhileGenerating
      ) {
        return;
      }

      await sleep(900);
    }

    throw new Error(`${this.name} timed out waiting for a stable response.`);
  }

  override async applyPreset(request: ProviderPromptRequest): Promise<void> {
    const presetName = request.execution?.preset;
    const page = this.lastPage;
    if (!presetName || !page) {
      return;
    }

    const preset = this.config.presets?.[presetName];
    const uiMode = preset?.uiMode;
    if (!uiMode) {
      return;
    }

    const timeoutMs = this.resolveTimeout(request);
    if (await this.isPresetVerified(page, uiMode)) {
      return;
    }

    const steps = uiMode.steps?.length ? uiMode.steps : [uiMode];
    for (const step of steps) {
      if (step.verifySelectors?.length && (await this.isPresetVerified(page, step))) {
        continue;
      }

      const changed = await this.applyPresetStep(page, step, timeoutMs);
      if (changed) {
        await sleep(step.waitAfterMs ?? 350);
      }

      if (step.verifySelectors?.length && !(await this.isPresetVerified(page, step))) {
        throw new Error(`${this.name} could not verify preset step for ${presetName}.`);
      }
    }

    if (uiMode.verifySelectors?.length && !(await this.isPresetVerified(page, uiMode))) {
      throw new Error(`${this.name} could not verify preset ${presetName}.`);
    }
  }

  protected resolveTimeout(request?: ProviderPromptRequest): number {
    return request?.execution?.timeoutMs ?? this.config.timeoutMs;
  }

  protected resolveTimeoutFromMeta(meta?: Record<string, unknown>): number {
    if (meta?.execution && typeof meta.execution === "object") {
      const timeoutMs = (meta.execution as { timeoutMs?: unknown }).timeoutMs;
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
        return timeoutMs;
      }
    }
    return this.config.timeoutMs;
  }

  private async clickFirstVisible(page: Page, selectors: string[], timeoutMs: number): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }

        await candidate.click({ timeout: timeoutMs, force: true }).catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  private async applyPresetStep(page: Page, uiMode: ProviderPresetUiAction | ProviderPresetUiMode, timeoutMs: number): Promise<boolean> {
    let changed = false;

    if (uiMode.directSelectors?.length) {
      if (await this.clickFirstVisible(page, uiMode.directSelectors, timeoutMs)) {
        changed = true;
      }
    }

    if (uiMode.openMenuSelectors?.length) {
      if (await this.clickFirstVisible(page, uiMode.openMenuSelectors, timeoutMs)) {
        changed = true;
        await sleep(250);
      }
    }

    if (uiMode.optionSelectors?.length && (await this.clickPresetOption(page, uiMode, timeoutMs))) {
      changed = true;
    }

    return changed;
  }

  private async clickPresetOption(page: Page, uiMode: ProviderPresetUiAction | ProviderPresetUiMode, timeoutMs: number): Promise<boolean> {
    for (const selector of uiMode.optionSelectors ?? []) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }

        if (uiMode.optionText) {
          const text = ((await candidate.innerText().catch(() => "")) || "").trim();
          if (!text.includes(uiMode.optionText)) {
            continue;
          }
        }

        await candidate.click({ timeout: timeoutMs, force: true }).catch(() => undefined);
        return true;
      }
    }

    return false;
  }

  private async isPresetVerified(page: Page, uiMode: ProviderPresetUiAction | ProviderPresetUiMode): Promise<boolean> {
    for (const selector of uiMode.verifySelectors ?? []) {
      if ((await page.locator(selector).count().catch(() => 0)) > 0) {
        return true;
      }
    }
    return false;
  }

  private async waitForSubmissionStart(
    page: Page,
    selectors: SelectorProfile,
    promptBeforeSubmit: string,
  ): Promise<boolean> {
    const deadline = Date.now() + 4_000;

    while (Date.now() < deadline) {
      if (await this.hasVisibleSelector(page, selectors.generationStopButtons ?? [])) {
        return true;
      }

      const promptAfterSubmit = await this.capturePromptInputText(page, selectors.promptTextarea);
      if (promptBeforeSubmit && promptAfterSubmit.trim().length < Math.max(8, Math.floor(promptBeforeSubmit.trim().length / 4))) {
        return true;
      }

      await sleep(150);
    }

    return false;
  }

  private async capturePromptInputText(page: Page, selectors: string[]): Promise<string> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) {
        continue;
      }

      const text = await locator
        .evaluate((element) => {
          if ("value" in element) {
            const value = (element as { value?: string }).value;
            return value ?? "";
          }

          return (element.textContent ?? "").trim();
        })
        .catch(() => "");

      if (text) {
        return text;
      }
    }

    return "";
  }

  private async isSubmitControlDisabled(
    locator: ReturnType<Page["locator"]>,
  ): Promise<boolean> {
    const disabled = await locator.isDisabled().catch(() => false);
    if (disabled) {
      return true;
    }

    const ariaDisabled = await locator.getAttribute("aria-disabled").catch(() => null);
    if (ariaDisabled === "true") {
      return true;
    }

    const dataDisabled = await locator.getAttribute("data-disabled").catch(() => null);
    return dataDisabled === "true";
  }

  private hasFreshValidatedSession(): boolean {
    return Boolean(this.lastPage) && Date.now() - this.lastSessionValidatedAt < 60_000;
  }

  private async hasVisibleSelector(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      if ((await page.locator(selector).count().catch(() => 0)) > 0) {
        return true;
      }
    }

    return false;
  }

  private async captureLatestResponseSnapshot(page: Page, selectors: string[]): Promise<ResponseSnapshot | null> {
    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count === 0) {
        continue;
      }

      const text = ((await locator.nth(count - 1).innerText().catch(() => "")) || "").trim();
      if (text) {
        return {
          selector,
          count,
          text,
        };
      }
    }

    return null;
  }

  private isNewResponseSnapshot(
    snapshot: ResponseSnapshot | null,
    baseline?: ResponseSnapshot | null,
  ): boolean {
    if (!snapshot) {
      return false;
    }

    if (!baseline) {
      return true;
    }

    if (snapshot.selector !== baseline.selector) {
      return true;
    }

    if (snapshot.count > baseline.count) {
      return true;
    }

    return snapshot.text !== baseline.text;
  }

  private isLikelyPromptEcho(text: string, promptText: string, selectors: SelectorProfile): boolean {
    if (!selectors.rejectPromptEcho || !text || !promptText) {
      return false;
    }

    const normalizedText = normalizeForComparison(text);
    const normalizedPrompt = normalizeForComparison(promptText);
    if (!normalizedText || !normalizedPrompt) {
      return false;
    }

    if (!normalizedText.includes(normalizedPrompt)) {
      return false;
    }

    const minExtraChars = selectors.promptEchoMinExtraChars ?? 220;
    return normalizedText.length < normalizedPrompt.length + minExtraChars;
  }
}

interface ResponseSnapshot {
  selector: string;
  count: number;
  text: string;
}

function normalizeForComparison(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function resolveSelectorProfilePath(configDir: string, relativePath: string): string {
  return resolve(configDir, relativePath);
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function classifyProviderFailure(
  message: string,
): "needs_browser_launch" | "provider_session_lost" | "needs_manual_login" | null {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("connect econrefused")
    || normalized.includes("retrieving websocket url")
    || normalized.includes("connectovercdp")
  ) {
    return "needs_browser_launch";
  }

  if (
    normalized.includes("login is missing or expired")
    || normalized.includes("requires manual recovery")
    || normalized.includes("blocked/risk-control page")
    || normalized.includes("blocked page")
  ) {
    return "needs_manual_login";
  }

  if (
    normalized.includes("target page, context or browser has been closed")
    || normalized.includes("page session was not initialized")
    || normalized.includes("browser has been closed")
    || normalized.includes("context closed")
  ) {
    return "provider_session_lost";
  }

  return null;
}
