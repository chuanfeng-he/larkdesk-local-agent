import { chromium } from "playwright";

const PROMPT = `请只回复 DOUBAO_NET_OK_${Date.now()}`;

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
  const seenHosts = new Map();
  const failures = [];

  try {
    const context = browser.contexts()[0];
    const page =
      context.pages().find((candidate) => candidate.url().includes("doubao.com/chat")) ??
      context.pages()[0];

    page.on("request", (request) => {
      try {
        const url = new URL(request.url());
        seenHosts.set(url.hostname, (seenHosts.get(url.hostname) ?? 0) + 1);
      } catch {
        // noop
      }
    });

    page.on("requestfailed", (request) => {
      failures.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? "unknown",
      });
    });

    await page.locator("[data-testid='chat_input_input']").first().click({ timeout: 10_000 });
    await page.locator("[data-testid='chat_input_input']").first().fill(PROMPT, { timeout: 10_000 });
    await page.locator("[data-testid='chat_input_send_button']").first().click({ timeout: 10_000 });
    await page.waitForTimeout(15_000);

    console.log(
      JSON.stringify(
        {
          url: page.url(),
          seenHosts: Array.from(seenHosts.entries()).sort((a, b) => a[0].localeCompare(b[0])),
          failures,
          bodyPreview: ((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 1800),
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}

void main();
