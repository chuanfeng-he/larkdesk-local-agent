import { resolve } from "node:path";
import type { ProviderAdapter, ProviderRuntimeConfig } from "@office-agent/core";
import { ChatGPTWebProvider } from "@office-agent/chatgpt-web";
import { ClaudeWebProvider } from "@office-agent/claude-web";
import { DeepSeekWebProvider } from "@office-agent/deepseek-web";
import { DoubaoWebProvider } from "@office-agent/doubao-web";
import { GeminiApiProvider } from "@office-agent/gemini-api";
import { GeminiWebProvider } from "@office-agent/gemini-web";
import { GrokWebProvider } from "@office-agent/grok-web";
import { MockProvider } from "@office-agent/mock-provider";
import { QwenWebProvider } from "@office-agent/qwen-web";

export function createProvider(config: ProviderRuntimeConfig, appConfigDir: string, screenshotDir: string): ProviderAdapter {
  switch (config.name) {
    case "mock_provider":
      return new MockProvider(config);
    case "gemini_api":
      return new GeminiApiProvider({
        ...config,
        name: "gemini_api",
        apiKey: process.env.GEMINI_API_KEY ?? "",
        model: process.env.GEMINI_API_MODEL ?? (config.metadata?.model as string) ?? "gemini-2.5-flash-lite",
        workspaceRoot: process.env.LOCAL_ACCESS_WORKSPACE_ROOT ?? process.cwd(),
      });
    case "chatgpt_web":
      return new ChatGPTWebProvider(config, resolve(appConfigDir, config.selectorProfile ?? ""), screenshotDir);
    case "deepseek_web":
      return new DeepSeekWebProvider(config, resolve(appConfigDir, config.selectorProfile ?? ""), screenshotDir);
    case "claude_web":
      return new ClaudeWebProvider(
        {
        ...config,
        name: "claude_web",
        },
        resolve(appConfigDir, config.selectorProfile ?? ""),
        screenshotDir,
      );
    case "gemini_web":
      return new GeminiWebProvider(
        {
        ...config,
        name: "gemini_web",
        },
        resolve(appConfigDir, config.selectorProfile ?? ""),
        screenshotDir,
      );
    case "doubao_web":
      return new DoubaoWebProvider(
        {
        ...config,
        name: "doubao_web",
        },
        resolve(appConfigDir, config.selectorProfile ?? ""),
        screenshotDir,
      );
    case "qwen_web":
      return new QwenWebProvider(
        {
          ...config,
          name: "qwen_web",
        },
        resolve(appConfigDir, config.selectorProfile ?? ""),
        screenshotDir,
      );
    case "grok_web":
      return new GrokWebProvider(
        {
          ...config,
          name: "grok_web",
        },
        resolve(appConfigDir, config.selectorProfile ?? ""),
        screenshotDir,
      );
    default:
      throw new Error(`Unknown provider: ${config.name}`);
  }
}
