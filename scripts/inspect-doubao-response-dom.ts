// @ts-nocheck
import { createServices } from "../apps/server/src/bootstrap";

async function main(): Promise<void> {
  const services = await createServices(process.cwd(), { startFeishuLongConnection: false });

  try {
    const provider = services.registry.get("doubao_web");
    if (!provider) {
      throw new Error("doubao_web is not registered.");
    }

    const session = await provider.ensureSession();
    console.log("SESSION");
    console.log(JSON.stringify(session, null, 2));

    const page = (provider as any).lastPage;
    if (!page) {
      throw new Error("doubao page is missing.");
    }

    const snapshot = await page.evaluate(() => {
      const doc = document as any;
      const loc = location as any;
      const selectors = [
        ".markdown",
        ".semi-typography",
        "[data-testid='assistant-message']",
        ".message-content",
        "[data-testid='message-content']",
        "main",
        "article",
        "[role='main']",
        "[class*='message']",
        "[class*='answer']",
      ];

      const counts = Object.fromEntries(
        selectors.map((selector) => [selector, doc.querySelectorAll(selector).length]),
      );

      const candidates = Array.from(doc.querySelectorAll("main *, article *, [role='main'] *"))
        .map((element: any) => {
          const text = (element?.textContent ?? "").trim();
          if (!text || text.length < 20) {
            return null;
          }

          return {
            tag: String(element?.tagName ?? "").toLowerCase(),
            className: typeof element?.className === "string" ? element.className : "",
            dataTestId: element?.getAttribute?.("data-testid") ?? null,
            role: element?.getAttribute?.("role") ?? null,
            text: text.slice(0, 220),
          };
        })
        .filter(Boolean)
        .slice(0, 80);

      return {
        title: doc.title,
        url: loc.href,
        counts,
        candidates,
      };
    });

    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await services.registry.closeAll().catch(() => undefined);
    await services.prisma.$disconnect().catch(() => undefined);
    await services.app.close().catch(() => undefined);
  }
}

void main();
