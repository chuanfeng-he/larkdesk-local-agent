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

    const handle = await provider.sendPrompt({
      taskId: "probe_doubao_submit",
      taskType: "SIMPLE",
      prompt: "请只回复 TEST_DOUBAO_OK",
      inputSummary: "probe",
    });

    console.log("HANDLE");
    console.log(JSON.stringify(handle, null, 2));

    const page = (provider as any).lastPage;
    if (!page) {
      throw new Error("doubao page is missing.");
    }

    await new Promise((resolve) => setTimeout(resolve, 65_000));

    const body = await page.locator("body").innerText().catch(() => "");
    const counts = {
      input: await page.locator("[data-testid='chat_input_input']").count().catch(() => 0),
      sendButtonTestId: await page.locator("[data-testid='chat_input_send_button']").count().catch(() => 0),
      sendButtonAny: await page.locator("button").filter({ hasText: "发送" }).count().catch(() => 0),
      submitButtons: await page.locator("button[type='submit']").count().catch(() => 0),
      markdown: await page.locator(".markdown").count().catch(() => 0),
      semiTypography: await page.locator(".semi-typography").count().catch(() => 0),
      main: await page.locator("main").count().catch(() => 0),
      answerLike: await page.locator("[class*='answer'], [class*='agent'], [class*='message']").count().catch(() => 0),
    };

    console.log("AFTER_SUBMIT");
    console.log(
      JSON.stringify(
        {
          url: page.url(),
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
