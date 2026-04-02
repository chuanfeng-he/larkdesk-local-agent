import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox } from "playwright";
import YAML from "yaml";

interface ProviderConfig {
  name: string;
  mode?: "persistent" | "cdp";
  browser?: "chromium" | "firefox";
  baseUrl?: string;
  profileDir?: string;
  cdpEndpoint?: string;
}

async function main(): Promise<void> {
  const providerName = process.argv[2] ?? "chatgpt_web";
  const configPath = resolve(process.cwd(), "config/providers.yaml");
  const content = await readFile(configPath, "utf8");
  const config = YAML.parse(content) as { providers: ProviderConfig[] };
  const provider = config.providers.find((item) => item.name === providerName);

  if (!provider?.baseUrl) {
    throw new Error(`Provider ${providerName} has no baseUrl configured.`);
  }

  if (provider.mode === "cdp") {
    const endpoint = provider.cdpEndpoint ?? "http://127.0.0.1:9222";
    const port = new URL(endpoint).port || "9222";
    const profileDir = provider.profileDir ? resolve(process.cwd(), provider.profileDir) : resolve(process.cwd(), ".profiles", providerName);
    console.log(`Provider ${providerName} uses CDP mode.`);
    console.log("请手动启动一个专用 Edge/Chromium 窗口，并保持窗口不要关闭：");
    console.log(
      `microsoft-edge --remote-debugging-port=${port} --user-data-dir=${profileDir} ${provider.baseUrl}`,
    );
    return;
  }

  if (!provider.profileDir) {
    throw new Error(`Provider ${providerName} has no profileDir/baseUrl configured.`);
  }

  const browserType = provider.browser === "firefox" ? firefox : chromium;
  const context = await browserType.launchPersistentContext(
    resolve(process.cwd(), provider.profileDir),
    provider.browser === "firefox"
      ? {
          headless: false,
        }
      : {
          headless: false,
          channel: "chromium",
        },
  );

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(provider.baseUrl, {
    waitUntil: "domcontentloaded",
  });

  console.log(`Browser opened for ${providerName} using ${provider.browser ?? "chromium"}. 完成手动登录后按 Ctrl+C 结束。`);
}

void main();
