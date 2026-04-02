import { createServices } from "../apps/server/src/bootstrap";

const DEFAULT_INPUT = "请用一句话介绍你自己";

async function main(): Promise<void> {
  const services = await createServices(process.cwd(), { startFeishuLongConnection: false });

  try {
    const input = process.argv.slice(2).join(" ").trim() || DEFAULT_INPUT;
    const accepted = await services.orchestrator.submitTask({
      input,
      requestedType: "SIMPLE",
      source: "acceptance",
    });

    console.log(`accepted task ${accepted.taskId} (${accepted.taskType})`);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const result = await services.orchestrator.getExecutionResult(accepted.taskId);
      const task = result?.task;
      if (!task) {
        throw new Error(`Task ${accepted.taskId} disappeared.`);
      }

      if (task.status === "completed" || task.status === "failed" || task.status === "needs_manual_login") {
        console.log(JSON.stringify(task, null, 2));
        return;
      }

      console.log(`poll ${task.id}: ${task.status}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Task ${accepted.taskId} timed out after 120s.`);
  } finally {
    await services.registry.closeAll().catch(() => undefined);
    await services.prisma.$disconnect().catch(() => undefined);
    await services.app.close().catch(() => undefined);
  }
}

void main();
