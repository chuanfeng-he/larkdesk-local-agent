import { buildApp } from "../apps/server/src/app";

async function main(): Promise<void> {
  const app = await buildApp(process.cwd());

  const createResponse = await app.inject({
    method: "POST",
    url: "/tasks",
    payload: {
      input: "请用最简洁的方式介绍这个本地优先飞书办公智能体的首版能力。",
    },
  });

  const created = createResponse.json() as { taskId: string };
  await waitForTask(app, created.taskId);

  const taskResponse = await app.inject({
    method: "GET",
    url: `/tasks/${created.taskId}`,
  });

  console.log(JSON.stringify(taskResponse.json(), null, 2));
  await app.close();
}

async function waitForTask(app: Awaited<ReturnType<typeof buildApp>>, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}`,
    });
    const task = response.json() as { status: string };
    if (task.status === "completed" || task.status === "failed" || task.status === "needs_manual_login") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

void main();

