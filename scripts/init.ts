import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import YAML from "yaml";

interface ProviderRuntimeConfig {
  profileDir?: string;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const configDir = resolve(cwd, "config");
  const content = await readFile(resolve(configDir, "providers.yaml"), "utf8");
  const providerConfig = YAML.parse(content) as {
    providers: ProviderRuntimeConfig[];
  };

  const dirs = new Set<string>([
    resolve(cwd, "data"),
    resolve(cwd, "data/runtime-logs"),
    resolve(cwd, "data/screenshots"),
    resolve(cwd, "data/task-artifacts"),
    resolve(cwd, ".profiles"),
  ]);

  for (const provider of providerConfig.providers) {
    if (provider.profileDir) {
      dirs.add(resolve(cwd, provider.profileDir));
    }
  }

  await Promise.all([...dirs].map((dir) => mkdir(dir, { recursive: true })));
  console.log("Initialized local directories.");
}

void main();
