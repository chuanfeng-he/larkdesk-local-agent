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
      console.log("NO_PAGE");
      return;
    }

    const url = page.url();
    const title = await page.title().catch(() => "");
    const body = await page.locator("body").innerText().catch(() => "");
    const counts = {
      loginBtn: await page.locator("button").filter({ hasText: "登录" }).count().catch(() => 0),
      registerBtn: await page.locator("button").filter({ hasText: "注册" }).count().catch(() => 0),
      input: await page.locator("[data-testid='chat_input_input']").count().catch(() => 0),
      send: await page.locator("[data-testid='chat_input_send_button']").count().catch(() => 0),
      markdown: await page.locator(".markdown").count().catch(() => 0),
      semiTypography: await page.locator(".semi-typography").count().catch(() => 0),
      userBubbles: await page.locator("[data-testid='message-content']").count().catch(() => 0),
    };

    console.log("PAGE");
    console.log(
      JSON.stringify(
        {
          url,
          title,
          counts,
          body: body.slice(0, 2000),
        },
        null,
        2,
      ),
    );
  } finally {
    await services.registry.closeAll().catch(() => undefined);
    await services.prisma.$disconnect().catch(() => undefined);
    await services.app.close().catch(() => undefined);
  }
}

void main();
