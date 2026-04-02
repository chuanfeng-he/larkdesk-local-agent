import { createServices } from "../apps/server/src/bootstrap";

async function main(): Promise<void> {
  const services = await createServices(process.cwd(), { startFeishuLongConnection: false });

  try {
    const targetNames = process.argv.slice(2);
    const health = await services.registry.refreshHealth();
    const filtered =
      targetNames.length > 0 ? health.filter((entry) => targetNames.includes(entry.provider)) : health;

    console.log(JSON.stringify(filtered, null, 2));
  } finally {
    await services.registry.closeAll().catch(() => undefined);
    await services.prisma.$disconnect().catch(() => undefined);
    await services.app.close().catch(() => undefined);
  }
}

void main();
