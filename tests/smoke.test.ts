import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app";

describe("server smoke", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const originalEnv = {
    SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED,
    FEISHU_USE_LONG_CONNECTION: process.env.FEISHU_USE_LONG_CONNECTION,
    CONFIG_HOT_RELOAD: process.env.CONFIG_HOT_RELOAD,
  };

  beforeAll(async () => {
    process.env.SCHEDULER_ENABLED = "false";
    process.env.FEISHU_USE_LONG_CONNECTION = "false";
    process.env.CONFIG_HOT_RELOAD = "false";
    app = await buildApp(process.cwd());
  });

  afterAll(async () => {
    await app.close();
    process.env.SCHEDULER_ENABLED = originalEnv.SCHEDULER_ENABLED;
    process.env.FEISHU_USE_LONG_CONNECTION = originalEnv.FEISHU_USE_LONG_CONNECTION;
    process.env.CONFIG_HOT_RELOAD = originalEnv.CONFIG_HOT_RELOAD;
  });

  it("returns health", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it("runs simple flow through mock provider", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        input: "请简单总结这个系统的用途。",
        requestedType: "SIMPLE",
        sourceMeta: {
          routeOverrides: {
            draftProvider: "mock_provider",
          },
        },
      },
    });

    expect(createResponse.statusCode).toBe(202);
    const created = createResponse.json() as { taskId: string };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = await app.inject({
        method: "GET",
        url: `/tasks/${created.taskId}`,
      });
      const task = detail.json() as { status: string; result?: { answer?: string; provider?: string } };
      if (task.status === "completed") {
        expect(task.result?.answer).toBeTruthy();
        expect(String(task.result?.provider ?? "")).not.toBe("");
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error("Task did not complete in time.");
  });

  it("marks api tasks for default feishu notifications", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        input: "请检查一下默认飞书通知标记。",
        requestedType: "SIMPLE",
        sourceMeta: {
          routeOverrides: {
            draftProvider: "mock_provider",
          },
        },
      },
    });

    expect(createResponse.statusCode).toBe(202);
    const created = createResponse.json() as { taskId: string };

    const detail = await app.inject({
      method: "GET",
      url: `/tasks/${created.taskId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      sourceMeta: {
        feishuNotify: true,
      },
    });
  });
});
