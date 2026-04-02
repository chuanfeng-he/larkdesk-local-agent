import { sleep, summarizeText } from "@office-agent/core";
import type { ProviderCompletion, ProviderPromptRequest, ProviderRunHandle, ProviderRuntimeConfig } from "@office-agent/core";
import { BaseWebProvider } from "@office-agent/web-playwright";
import type { SelectorProfile } from "@office-agent/web-playwright";
import { doubaoSiteProfile } from "./siteProfile";

const DOUBAO_COMPLETION_MARKERS = [
  "[data-testid='message_action_regenerate']",
  "[data-testid='message_action_like']",
  "[data-testid='message_action_dislike']",
  "[data-testid='message_action_copy']",
  "[data-testid='message_action_share']",
];

const DOUBAO_FALLBACK_STABLE_TICKS = 5;
const DOUBAO_MIN_FALLBACK_ANSWER_LENGTH = 12;

const DOUBAO_IMAGE_READY_MARKERS = [
  "[data-testid='image-creation-chat-input-picture-reference-button']",
  "[data-testid='image-creation-chat-input-picture-model-button']",
  "[data-testid='image-creation-chat-input-picture-ration-button']",
  "[data-testid='image-creation-chat-input-picture-style-button']",
];

export class DoubaoWebProvider extends BaseWebProvider {
  constructor(config: ProviderRuntimeConfig, selectorProfilePath: string, screenshotDir: string) {
    super(config, doubaoSiteProfile, selectorProfilePath, screenshotDir);
  }

  override async sendPrompt(request: ProviderPromptRequest): Promise<ProviderRunHandle> {
    if (getWorkflowIntent(request) === "image") {
      return this.sendImagePrompt(request);
    }

    const handle = await super.sendPrompt(request);
    const page = this.getActivePage();

    if (!page) {
      return handle;
    }

    const completionMarkerBaseline = await countVisibleSelectors(page, DOUBAO_COMPLETION_MARKERS);
    return {
      ...handle,
      meta: {
        ...handle.meta,
        doubaoCompletionMarkerBaseline: completionMarkerBaseline,
        execution: request.execution,
      },
    };
  }

  override async waitForCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion> {
    if (handle.meta?.doubaoImageMode) {
      return this.waitForImageCompletion(handle);
    }

    const selectors = (handle.meta?.selectors ?? {}) as SelectorProfile;
    const promptText = typeof handle.meta?.promptText === "string" ? handle.meta.promptText : "";
    const baseline = (handle.meta?.responseBaseline ?? null) as ResponseSnapshot | null;
    const completionMarkerBaseline = Number(handle.meta?.doubaoCompletionMarkerBaseline ?? 0);
    const page = this.getActivePage();

    if (!page) {
      throw new Error(`${this.name} page session was not initialized.`);
    }

    const deadline = Date.now() + this.resolveTimeoutFromMeta(handle.meta);
    let lastCleanedText = "";
    let stableTicks = 0;

    while (Date.now() < deadline) {
      const snapshot = await captureLatestResponseSnapshot(page, selectors.responseBlocks);
      const rawText = snapshot?.text ?? "";
      const cleanedText = sanitizeDoubaoOutput(rawText, promptText);
      const completionMarkerCount = await countVisibleSelectors(page, DOUBAO_COMPLETION_MARKERS);
      const hasCompletedControls = completionMarkerCount > 0;
      const isNewResponse = isNewSnapshot(snapshot, baseline);

      if (cleanedText && cleanedText === lastCleanedText) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
        lastCleanedText = cleanedText;
      }

      if (cleanedText && isNewResponse && hasCompletedControls && stableTicks >= 2) {
        return {
          provider: handle.provider,
          completedAt: new Date(),
          meta: {
            ...handle.meta,
            doubaoCompletionMarkerCount: completionMarkerCount,
            doubaoCompletionStrategy: completionMarkerCount > completionMarkerBaseline ? "marker_increase" : "marker_present",
          },
        };
      }

      if (shouldAcceptDoubaoFallback(cleanedText, isNewResponse, stableTicks)) {
        return {
          provider: handle.provider,
          completedAt: new Date(),
          meta: {
            ...handle.meta,
            doubaoCompletionMarkerCount: completionMarkerCount,
            doubaoCompletionStrategy: "stable_text_fallback",
          },
        };
      }

      await sleep(900);
    }

    const finalSnapshot = await captureLatestResponseSnapshot(page, selectors.responseBlocks);
    const finalText = sanitizeDoubaoOutput(finalSnapshot?.text ?? "", promptText);
    if (shouldAcceptDoubaoTimeoutFallback(finalText, finalSnapshot, baseline)) {
      return {
        provider: handle.provider,
        completedAt: new Date(),
        meta: {
          ...handle.meta,
          doubaoCompletionStrategy: "timeout_extract_fallback",
        },
      };
    }

    throw new Error(`${this.name} timed out waiting for dedicated doubao completion markers.`);
  }

  override async extractAnswer(completion: ProviderCompletion): Promise<{
    provider: string;
    outputText: string;
    summary: string;
    meta?: Record<string, unknown>;
  }> {
    if (completion.meta?.doubaoImageMode) {
      const imageResults = normalizeImageResults(completion.meta?.imageResults);
      if (imageResults.length === 0) {
        throw new Error("doubao_web did not return any generated images.");
      }

      const outputText = `已生成 ${imageResults.length} 张图片。`;
      return {
        provider: this.name,
        outputText,
        summary: summarizeText(outputText, 280),
        meta: {
          ...((completion.meta ?? {}) as Record<string, unknown>),
          baseUrl: this.getConfig().baseUrl,
          imageResults,
        },
      };
    }

    const result = await super.extractAnswer(completion);
    const promptText = typeof completion.meta?.promptText === "string" ? completion.meta.promptText : "";
    const cleaned = sanitizeDoubaoOutput(result.outputText, promptText);

    if (!cleaned) {
      throw new Error("doubao_web detected prompt echo but no stable assistant answer yet.");
    }

    return {
      ...result,
      outputText: cleaned,
      summary: summarizeText(cleaned, 280),
    };
  }

  private async sendImagePrompt(request: ProviderPromptRequest): Promise<ProviderRunHandle> {
    const selectors = await this.loadSelectors();
    const page = this.getActivePage();
    if (!page) {
      throw new Error(`${this.name} page session was not initialized.`);
    }

    await page
      .goto(this.getConfig().baseUrl ?? "about:blank", {
        waitUntil: "domcontentloaded",
        timeout: request.execution?.timeoutMs ?? this.getConfig().timeoutMs,
      })
      .catch((error: unknown) => {
        const currentUrl = typeof page.url === "function" ? page.url() : "";
        if (currentUrl.includes("doubao.com/chat")) {
          return null;
        }

        throw error;
      });
    const timeoutMs = request.execution?.timeoutMs ?? this.getConfig().timeoutMs;
    await sleep(1_200);
    await startFreshConversation(page, timeoutMs);
    await ensureDoubaoImageMode(page, timeoutMs);
    await fillPromptWithoutClick(page, selectors.promptTextarea, request.prompt, timeoutMs);
    await submitPromptWithForce(page, selectors.submitButton ?? ["[data-testid='chat_input_send_button']"], timeoutMs);

    return {
      provider: this.name,
      startedAt: new Date(),
      meta: {
        selectors,
        promptText: request.prompt,
        doubaoImageMode: true,
        execution: request.execution,
      },
    };
  }

  private async waitForImageCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion> {
    const page = this.getActivePage();
    if (!page) {
      throw new Error(`${this.name} page session was not initialized.`);
    }

    const deadline = Date.now() + this.resolveTimeoutFromMeta(handle.meta);
    let lastSignature = "";
    let stableTicks = 0;

    while (Date.now() < deadline) {
      const imageResults = normalizeImageResults(await captureLatestReceiveMessageImages(page));
      const signature = imageResults.map((item) => item.url).join("|");

      if (signature && signature === lastSignature) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
        lastSignature = signature;
      }

      if (imageResults.length > 0 && stableTicks >= 2) {
        return {
          provider: handle.provider,
          completedAt: new Date(),
          meta: {
            ...handle.meta,
            imageResults,
          },
        };
      }

      await sleep(1_500);
    }

    throw new Error(`${this.name} timed out waiting for generated images.`);
  }
}

function sanitizeDoubaoOutput(outputText: string, promptText: string): string {
  let text = outputText.trim();
  if (!text) {
    return "";
  }

  text = text
    .replace(/^新对话\s*/u, "")
    .replace(/^内容由豆包 AI 生成\s*/u, "")
    .trim();

  if (promptText) {
    const promptIndex = text.indexOf(promptText.trim());
    if (promptIndex >= 0) {
      text = text.slice(promptIndex + promptText.trim().length).trim();
    }
  }

  text = text
    .replace(/^(快速|超能模式|Beta|PPT 生成|图像生成|帮我写作|更多)\s*/gu, "")
    .trim();

  text = stripPromptTemplateArtifacts(text).trim();

  return text;
}

function stripPromptTemplateArtifacts(input: string): string {
  let text = input;

  const hardMarkers = [
    "你是本地优先办公智能体中的豆包网页模型节点",
    "请直接输出适合办公场景的简洁结论和结构化建议",
    "请优先输出适合办公场景的简洁结论和结构化建议",
    "如果发现网页登录失效、风控或人工验证，请明确说明需要人工恢复登录",
    "任务类型：",
    "用户输入：",
    "原问题摘要：",
    "草稿摘要：",
    "要求：",
    "请按这个结构输出：",
  ];

  if (hardMarkers.some((marker) => text.includes(marker))) {
    for (const marker of hardMarkers) {
      text = text.split(marker).join("");
    }

    text = text
      .replace(/- 先给出简明结论/gu, "")
      .replace(/- 再给出最多 5 条可执行建议/gu, "")
      .replace(/- 不要泄露任何敏感信息/gu, "")
      .replace(/- 如果网页需要人工恢复登录，请直接说明/gu, "")
      .replace(/1\. 问题点/gu, "")
      .replace(/2\. 修订建议/gu, "")
      .replace(/3\. 最终意见/gu, "")
      .trim();
  }

  return text;
}

async function countVisibleSelectors(page: any, selectors: string[]): Promise<number> {
  let total = 0;

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const visible = await locator
        .nth(index)
        .isVisible()
        .catch(() => false);
      if (visible) {
        total += 1;
      }
    }
  }

  return total;
}

async function captureLatestResponseSnapshot(page: any, selectors: string[]): Promise<ResponseSnapshot | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }

    const text = ((await locator.nth(count - 1).innerText().catch(() => "")) || "").trim();
    if (!text) {
      continue;
    }

    return {
      selector,
      count,
      text,
    };
  }

  return null;
}

function isNewSnapshot(snapshot: ResponseSnapshot | null, baseline: ResponseSnapshot | null): boolean {
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

function shouldAcceptDoubaoFallback(cleanedText: string, isNewResponse: boolean, stableTicks: number): boolean {
  return Boolean(
    cleanedText &&
      isNewResponse &&
      cleanedText.length >= DOUBAO_MIN_FALLBACK_ANSWER_LENGTH &&
      stableTicks >= DOUBAO_FALLBACK_STABLE_TICKS,
  );
}

function shouldAcceptDoubaoTimeoutFallback(
  cleanedText: string,
  snapshot: ResponseSnapshot | null,
  baseline: ResponseSnapshot | null,
): boolean {
  if (!cleanedText || cleanedText.length < DOUBAO_MIN_FALLBACK_ANSWER_LENGTH) {
    return false;
  }

  return isNewSnapshot(snapshot, baseline);
}

interface ResponseSnapshot {
  selector: string;
  count: number;
  text: string;
}

interface DoubaoImageResult {
  url: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

function getWorkflowIntent(request: ProviderPromptRequest): string | null {
  const context = request.context;
  if (!context || typeof context !== "object") {
    return null;
  }

  return typeof context.workflowIntent === "string" ? context.workflowIntent : null;
}

async function ensureDoubaoImageMode(page: any, timeoutMs: number): Promise<void> {
  const markerVisible = await hasAnyVisibleSelector(page, DOUBAO_IMAGE_READY_MARKERS);
  if (markerVisible) {
    return;
  }

  const trigger = page.locator("button").filter({ hasText: "图像生成" }).first();
  await trigger.waitFor({ state: "visible", timeout: timeoutMs });
  await trigger.click({ timeout: timeoutMs, force: true });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasAnyVisibleSelector(page, DOUBAO_IMAGE_READY_MARKERS)) {
      return;
    }

    await sleep(250);
  }

  throw new Error("doubao_web failed to enter image mode.");
}

async function fillPromptWithoutClick(page: any, selectors: string[], text: string, timeoutMs: number): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      continue;
    }

    try {
      await locator.fill(text, { timeout: timeoutMs });
      return;
    } catch {
      // Fall through to force strategies below.
    }

    try {
      await locator.click({ timeout: 3_000, force: true });
      await locator.fill(text, { timeout: timeoutMs });
      return;
    } catch {
      // Fall through to DOM-level value injection.
    }

    try {
      await locator.evaluate((element: any, value: string) => {
        const EventCtor = (globalThis as any).Event;
        const InputEventCtor = (globalThis as any).InputEvent ?? EventCtor;
        if ("value" in element) {
          element.value = value;
          element.dispatchEvent(new EventCtor("input", { bubbles: true }));
          element.dispatchEvent(new EventCtor("change", { bubbles: true }));
          return;
        }

        element.focus?.();
        element.textContent = value;
        element.dispatchEvent(new InputEventCtor("input", { bubbles: true, data: value, inputType: "insertText" }));
      }, text);
      return;
    } catch {
      // Continue to next selector.
    }
  }

  throw new Error("doubao_web could not fill the image prompt input.");
}

async function submitPromptWithForce(page: any, selectors: string[], timeoutMs: number): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      const disabled = await candidate.isDisabled().catch(() => false);
      if (!visible || disabled) {
        continue;
      }

      await candidate.click({ timeout: timeoutMs, force: true });
      return;
    }
  }

  throw new Error("doubao_web could not find the image submit button.");
}

async function captureImageResults(page: any, baselineUrls: string[] = []): Promise<DoubaoImageResult[]> {
  void baselineUrls;
  return captureLatestReceiveMessageImages(page);
}

function normalizeImageResults(raw: unknown): DoubaoImageResult[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<string>();
  const results: DoubaoImageResult[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const rawUrl = typeof (item as Record<string, unknown>).url === "string" ? ((item as Record<string, unknown>).url as string) : "";
    const compareKey = normalizeDoubaoImageUrl(rawUrl);
    if (!rawUrl || !compareKey || seen.has(compareKey)) {
      continue;
    }

    seen.add(compareKey);
    results.push({
      url: rawUrl,
      width: typeof (item as Record<string, unknown>).width === "number" ? ((item as Record<string, unknown>).width as number) : undefined,
      height: typeof (item as Record<string, unknown>).height === "number" ? ((item as Record<string, unknown>).height as number) : undefined,
      mimeType:
        typeof (item as Record<string, unknown>).mimeType === "string"
          ? ((item as Record<string, unknown>).mimeType as string)
          : undefined,
    });
  }

  return results;
}

async function hasAnyVisibleSelector(page: any, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        return true;
      }
    }
  }

  return false;
}

function normalizeDoubaoImageUrl(url: string): string {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function captureLatestReceiveMessageImages(page: any): Promise<DoubaoImageResult[]> {
  const results = (await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const messages = Array.from(doc?.querySelectorAll?.("[data-testid='receive_message']") ?? []);
    const latestMessage = messages.at(-1);
    if (!latestMessage) {
      return [];
    }

    const seen = new Set<string>();
    const items: Array<{ url: string; width?: number; height?: number }> = [];
    const images = Array.from((latestMessage as any).querySelectorAll?.("img") ?? []);

    for (const rawImage of images) {
      const image = rawImage as any;
      const src = typeof image.src === "string" ? image.src : "";
      const className = typeof image.className === "string" ? image.className : "";
      if (!src || src.startsWith("data:")) {
        continue;
      }

      const looksLikeGenerated = src.includes("/rc_gen_image/") || className.includes("image-Q7dBqW");
      if (!looksLikeGenerated) {
        continue;
      }

      const normalizedUrl = normalizeDoubaoImageUrl(src);
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        continue;
      }

      seen.add(normalizedUrl);
      items.push({
        url: src,
        width: Number(image.naturalWidth || 0) || undefined,
        height: Number(image.naturalHeight || 0) || undefined,
      });
    }

    return items;

    function normalizeDoubaoImageUrl(url: string): string {
      if (!url) {
        return "";
      }

      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return url;
      }
    }
  })) as DoubaoImageResult[];

  return normalizeImageResults(results);
}

async function startFreshConversation(page: any, timeoutMs: number): Promise<void> {
  const trigger = page.locator("a,button").filter({ hasText: "新对话" }).first();
  const count = await trigger.count().catch(() => 0);
  if (count === 0) {
    return;
  }

  await trigger.click({ timeout: Math.min(timeoutMs, 5_000), force: true }).catch(() => undefined);
  await sleep(800);
}
