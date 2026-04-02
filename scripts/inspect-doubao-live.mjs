import { chromium } from "playwright";

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");

  try {
    const context = browser.contexts()[0];
    const page =
      context.pages().find((candidate) => candidate.url().includes("doubao.com/chat")) ??
      context.pages()[0];

    const data = await page.evaluate(() => {
      const selectors = [
        "[data-testid='message_text_content']",
        "[data-testid='receive_message']",
        "[data-testid='message_action_regenerate']",
        "[data-testid='message_action_like']",
        "[data-testid='message_action_dislike']",
        "[data-testid='message_action_copy']",
        "[data-testid='message_action_share']",
        "[data-testid='chat_input_send_button']",
        "[data-testid='chat_input_input']",
      ];

      const counts = Object.fromEntries(selectors.map((selector) => [selector, document.querySelectorAll(selector).length]));
      const send = document.querySelector("[data-testid='chat_input_send_button']");
      const visibleButtons = Array.from(document.querySelectorAll("button, [role='button']"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0";
          if (!visible) {
            return null;
          }

          return {
            tag: element.tagName.toLowerCase(),
            dataTestId: element.getAttribute("data-testid"),
            id: element.id || null,
            ariaLabel: element.getAttribute("aria-label"),
            disabled: element.getAttribute("disabled") !== null || element.getAttribute("aria-disabled") === "true",
            text: (element.innerText || element.textContent || "").trim().slice(0, 120),
            className: typeof element.className === "string" ? element.className.slice(0, 220) : "",
          };
        })
        .filter(Boolean)
        .slice(0, 80);
      const latestTextNodes = Array.from(document.querySelectorAll("[data-testid='message_text_content']"))
        .slice(-5)
        .map((element) => ({
          text: (element.innerText || element.textContent || "").trim(),
          className: typeof element.className === "string" ? element.className : "",
        }));

      return {
        url: location.href,
        title: document.title,
        counts,
        send: send
          ? {
              id: send.id || null,
              className: typeof send.className === "string" ? send.className.slice(0, 240) : "",
              text: (send.innerText || send.textContent || "").trim(),
              ariaLabel: send.getAttribute("aria-label"),
              disabled: send.getAttribute("disabled") !== null || send.getAttribute("aria-disabled") === "true",
            }
          : null,
        visibleButtons,
        latestTextNodes,
        bodyPreview: (document.body.innerText || "").slice(0, 2000),
      };
    });

    console.log(JSON.stringify(data, null, 2));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

void main();
