import { createServices } from "../apps/server/src/bootstrap";

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) {
    throw new Error("Usage: pnpm exec tsx scripts/get-task.ts <taskId>");
  }

  const services = await createServices(process.cwd(), { startFeishuLongConnection: false });
  try {
    const task = await services.store.getTask(taskId);
    console.log(JSON.stringify(task, null, 2));
  } finally {
    await services.registry.closeAll().catch(() => undefined);
    await services.prisma.$disconnect().catch(() => undefined);
    await services.app.close().catch(() => undefined);
  }
}

void main();
