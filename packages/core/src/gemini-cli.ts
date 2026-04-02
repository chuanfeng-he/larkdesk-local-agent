import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const DEFAULT_GEMINI_CLI_MODEL = "gemini-2.5-flash-lite";
export const DEFAULT_GEMINI_AUTH_TYPE = "gemini-api-key";

export function prepareGeminiCliArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (hasGeminiModelOverride(args) || env.GEMINI_MODEL) {
    return [...args];
  }

  return ["--model", DEFAULT_GEMINI_CLI_MODEL, ...args];
}

export function prepareGeminiCliEnv(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolatedHome = env.GEMINI_CLI_HOME ?? join(
    tmpdir(),
    "office-agent",
    "gemini-cli",
    createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12),
  );
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    GEMINI_CLI_HOME: isolatedHome,
    GEMINI_MODEL: env.GEMINI_MODEL ?? DEFAULT_GEMINI_CLI_MODEL,
  };

  if (env.GEMINI_API_KEY) {
    nextEnv.GEMINI_DEFAULT_AUTH_TYPE = DEFAULT_GEMINI_AUTH_TYPE;
    delete nextEnv.GOOGLE_GENAI_USE_GCA;
    delete nextEnv.GOOGLE_GENAI_USE_VERTEXAI;
  }

  return nextEnv;
}

function hasGeminiModelOverride(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model" || arg === "-m") {
      return true;
    }

    if (arg.startsWith("--model=") || arg.startsWith("-m=")) {
      return true;
    }
  }

  return false;
}
