import { createServices } from "../apps/server/src/bootstrap";

const DEFAULT_INPUT =
  "请评审这个办公智能体的路由策略：简单任务优先 cheap provider，复杂任务先草稿再复审再仲裁。请直接给出最终建议，控制在 6 句话内。";

async function main(): Promise<void> {
  const services = await createServices(process.cwd(), { startFeishuLongConnection: false });

  try {
    const input = process.argv.slice(2).join(" ").trim() || DEFAULT_INPUT;
    const submission = {
      input,
      requestedType: "COMPLEX" as const,
      requestedIntent: "office_discussion" as const,
      budget: "standard" as const,
      source: "acceptance",
      sourceMeta: {
        scenario: "gemini_review_chatgpt_arbiter",
      },
    };

    const accepted = await services.orchestrator.submitTask(submission);
    console.log(`accepted task ${accepted.taskId} (${accepted.taskType})`);

    const deadline = Date.now() + 180_000;
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
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    throw new Error(`Task ${accepted.taskId} timed out after 180s.`);
  } finally {
    await services.registry.closeAll().catch(() => undefined);
    await services.prisma.$disconnect().catch(() => undefined);
    await services.app.close().catch(() => undefined);
  }
}

await main();
