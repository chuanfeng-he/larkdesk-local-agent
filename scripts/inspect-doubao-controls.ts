// @ts-nocheck
import { chromium } from "playwright";

const CDP_ENDPOINT = "http://127.0.0.1:9224";
const PROMPT = `请只回复 DOUBAO_CTRL_OK_${Date.now()}`;
const SAMPLE_DELAYS_MS = [500, 2_000, 5_000, 10_000, 20_000, 35_000];

async function main(): Promise<void> {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Doubao CDP context is missing.");
    }

    const page =
      context.pages().find((candidate) => candidate.url().includes("doubao.com/chat")) ??
      context.pages()[0] ??
      (await context.newPage());

    if (!page.url()) {
      await page.goto("https://www.doubao.com/chat/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }

    await page.waitForTimeout(1_000);
    await page.locator("[data-testid='chat_input_input']").first().click({ timeout: 10_000 });
    await page.locator("[data-testid='chat_input_input']").first().fill(PROMPT, { timeout: 10_000 });

    const before = await snapshot(page, "before_submit", PROMPT);
    console.log(JSON.stringify(before, null, 2));

    await page.locator("[data-testid='chat_input_send_button']").first().click({ timeout: 10_000 });

    for (const delay of SAMPLE_DELAYS_MS) {
      await page.waitForTimeout(delay);
      const phase = await snapshot(page, `after_${delay}ms`, PROMPT);
      console.log(JSON.stringify(phase, null, 2));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function snapshot(page: any, phase: string, prompt: string) {
  return page.evaluate(
    function ({ currentPhase, currentPrompt }) {
      function isVisible(element: Element | null | undefined): boolean {
        if (!element) {
          return false;
        }

        const rect = (element as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(element as HTMLElement);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      }

      function summarizeElement(element: Element | null | undefined) {
        if (!element) {
          return null;
        }

        const node = element as HTMLElement;
        const text = (node.innerText || node.textContent || "").trim();
        return {
          tag: node.tagName.toLowerCase(),
          className: typeof node.className === "string" ? node.className.slice(0, 240) : "",
          id: node.id || null,
          dataTestId: node.getAttribute("data-testid"),
          role: node.getAttribute("role"),
          ariaLabel: node.getAttribute("aria-label"),
          disabled: node.getAttribute("disabled") !== null || node.getAttribute("aria-disabled") === "true",
          text: text.slice(0, 300),
        };
      }

      const buttonSelectors = [
        "[data-testid='chat_input_send_button']",
        "[data-testid='chat_input'] button",
        "button[aria-label]",
        "button",
        "[role='button']",
      ];

      const visibleButtons = Array.from(
        new Set(buttonSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))),
      )
        .filter((element) => isVisible(element))
        .map((element) => summarizeElement(element))
        .filter((item) => item && (item.text || item.ariaLabel || item.dataTestId || item.className))
        .slice(0, 60);

      const keywordHits = Array.from(document.querySelectorAll("body *"))
        .filter((element) => isVisible(element))
        .map((element) => {
          const text = ((element as HTMLElement).innerText || element.textContent || "").trim();
          if (!text) {
            return null;
          }

          if (!/(停止|生成中|重新生成|重试|复制|点赞|点踩|分享|继续|展开|收起|AI生成|内容由豆包|重答)/u.test(text)) {
            return null;
          }

          return summarizeElement(element);
        })
        .filter(Boolean)
        .slice(0, 80);

      const assistantCandidates = Array.from(document.querySelectorAll("main *, article *, [role='main'] *"))
        .filter((element) => isVisible(element))
        .map((element) => {
          const text = ((element as HTMLElement).innerText || element.textContent || "").trim();
          if (!text || text.length < 12) {
            return null;
          }

          if (text.includes(currentPrompt)) {
            return null;
          }

          return summarizeElement(element);
        })
        .filter(Boolean)
        .slice(0, 80);

      const sendButton = document.querySelector("[data-testid='chat_input_send_button']");
      const input = document.querySelector("[data-testid='chat_input_input']");

      const bodyText = (document.body.innerText || "").trim();

      return {
        phase: currentPhase,
        url: location.href,
        title: document.title,
        sendButton: summarizeElement(sendButton),
        input: summarizeElement(input),
        visibleButtons,
        keywordHits,
        assistantCandidates,
        bodyPreview: bodyText.slice(0, 3000),
      };
    },
    { currentPhase: phase, currentPrompt: prompt },
  );
}

void main();
