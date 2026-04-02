import { chromium } from "playwright";

const CDP_ENDPOINT = "http://127.0.0.1:9224";
const PROMPT = `请只回复 DOUBAO_CTRL_OK_${Date.now()}`;
const SAMPLE_DELAYS_MS = [500, 2_000, 5_000, 10_000, 20_000, 35_000];

async function main() {
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

    console.log(JSON.stringify(await snapshot(page, "before_submit", PROMPT), null, 2));

    await page.locator("[data-testid='chat_input_send_button']").first().click({ timeout: 10_000 });

    for (const delay of SAMPLE_DELAYS_MS) {
      await page.waitForTimeout(delay);
      console.log(JSON.stringify(await snapshot(page, `after_${delay}ms`, PROMPT), null, 2));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function snapshot(page, phase, prompt) {
  return page.evaluate(
    ({ currentPhase, currentPrompt }) => {
      function isVisible(element) {
        if (!element) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      }

      function summarizeElement(element) {
        if (!element) {
          return null;
        }

        const text = (element.innerText || element.textContent || "").trim();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className.slice(0, 240) : "",
          id: element.id || null,
          dataTestId: element.getAttribute("data-testid"),
          role: element.getAttribute("role"),
          ariaLabel: element.getAttribute("aria-label"),
          disabled: element.getAttribute("disabled") !== null || element.getAttribute("aria-disabled") === "true",
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

      const uniqueButtons = [];
      const seen = new Set();
      for (const selector of buttonSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (seen.has(element)) {
            continue;
          }
          seen.add(element);
          uniqueButtons.push(element);
        }
      }

      const visibleButtons = uniqueButtons
        .filter((element) => isVisible(element))
        .map((element) => summarizeElement(element))
        .filter((item) => item && (item.text || item.ariaLabel || item.dataTestId || item.className))
        .slice(0, 80);

      const keywordHits = Array.from(document.querySelectorAll("body *"))
        .filter((element) => isVisible(element))
        .map((element) => {
          const text = (element.innerText || element.textContent || "").trim();
          if (!text) {
            return null;
          }

          if (!/(停止|生成中|重新生成|重试|复制|点赞|点踩|分享|继续|展开|收起|AI生成|内容由豆包|重答|搜索)/u.test(text)) {
            return null;
          }

          return summarizeElement(element);
        })
        .filter(Boolean)
        .slice(0, 120);

      const assistantCandidates = Array.from(document.querySelectorAll("main *, article *, [role='main'] *"))
        .filter((element) => isVisible(element))
        .map((element) => {
          const text = (element.innerText || element.textContent || "").trim();
          if (!text || text.length < 12) {
            return null;
          }

          if (text.includes(currentPrompt)) {
            return null;
          }

          return summarizeElement(element);
        })
        .filter(Boolean)
        .slice(0, 120);

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
