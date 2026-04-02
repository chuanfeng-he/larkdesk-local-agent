import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv(process.cwd());
const app = await buildApp(process.cwd());

try {
  await app.listen({
    port: env.port,
    host: env.host,
  });
  app.log.info(`Server listening on http://${env.host}:${env.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

