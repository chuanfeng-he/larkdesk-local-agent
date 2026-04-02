import { AbstractProviderAdapter } from "@office-agent/core";
import type {
  ModelPresetName,
  ProviderCompletion,
  ProviderHealth,
  ProviderPromptRequest,
  ProviderRunHandle,
  ProviderRunResult,
  ProviderRuntimeConfig,
  SessionState,
} from "@office-agent/core";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface GeminiApiConfig extends ProviderRuntimeConfig {
  apiKey: string;
  model?: string;
  workspaceRoot?: string;
}

interface GeminiHandleMeta extends Record<string, unknown> {
  responseText: string;
  functionCallResults?: string[];
  model?: string;
}

interface GeminiFunctionSchema {
  type: "OBJECT" | "STRING";
  description?: string;
  properties?: Record<string, GeminiFunctionSchema>;
  required?: string[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiFunctionSchema;
}

interface GeminiContentPart {
  text?: string;
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: {
      result: string;
    };
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiContentPart[];
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiContentPart[];
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_SYSTEM_INSTRUCTION =
  "你是一个可靠的中文助手。"
  + "默认直接说事、简洁清楚，不要空话和客套。"
  + "如果问题涉及技术、学术、工程、科研或专业概念，必须保证术语准确、表达严谨；优先给出定义，再概括关键特征、优缺点、适用条件与边界。"
  + "除非用户明确要口语化，否则不要把专业问题回答得过于随意。"
  + "如果用户需要操作文件/文件夹，使用提供的工具函数来执行。";

const localToolDeclarations: GeminiFunctionDeclaration[] = [
  {
    name: "createFolder",
    description: "Create a folder at the specified path relative to workspace root",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path of the folder to create" },
      },
      required: ["path"],
    },
  },
  {
    name: "moveFile",
    description: "Move or rename a file/folder from src to dst, relative to workspace root",
    parameters: {
      type: "OBJECT",
      properties: {
        src: { type: "STRING", description: "Source relative path" },
        dst: { type: "STRING", description: "Destination relative path" },
      },
      required: ["src", "dst"],
    },
  },
  {
    name: "writeFile",
    description: "Write text content to a file at the specified path relative to workspace root",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path of the file" },
        content: { type: "STRING", description: "Text content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "listDir",
    description: "List the contents of a directory relative to workspace root",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Relative path of the directory (use '.' for root)" },
      },
      required: ["path"],
    },
  },
];

export class GeminiApiProvider extends AbstractProviderAdapter {
  readonly kind = "api" as const;
  private readonly apiKey: string;
  private readonly defaultModelName: string;
  private readonly workspaceRoot: string;
  private cooldownUntil = 0;

  constructor(config: GeminiApiConfig) {
    super(config.name, config);
    this.apiKey = config.apiKey;
    this.defaultModelName = config.model ?? "gemini-2.5-flash-lite";
    this.workspaceRoot = config.workspaceRoot ?? process.cwd();
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (Date.now() < this.cooldownUntil) {
      return {
        provider: this.name,
        status: "unhealthy",
        detail: `Gemini API on cooldown until ${new Date(this.cooldownUntil).toISOString()}`,
        checkedAt: new Date(),
        recoveryHint: "Rate limit cooldown active. Will auto-recover.",
      };
    }

    if (!this.apiKey) {
      return {
        provider: this.name,
        status: "unhealthy",
        detail: "Gemini API error: GEMINI_API_KEY is missing.",
        checkedAt: new Date(),
        recoveryHint: "Set GEMINI_API_KEY in .env before enabling the gemini_api provider.",
      };
    }

    return {
      provider: this.name,
      status: "available",
      detail: `Gemini API (${this.defaultModelName}) is configured.`,
      checkedAt: new Date(),
      recoveryHint: "Runtime connectivity and quota will be validated on the first real request.",
    };
  }

  async ensureSession(): Promise<SessionState> {
    return {
      ok: true,
      detail: "Gemini API does not require a browser session.",
    };
  }

  async sendPrompt(request: ProviderPromptRequest): Promise<ProviderRunHandle> {
    if (Date.now() < this.cooldownUntil) {
      throw new Error("Gemini API on rate-limit cooldown, skipping to fallback provider.");
    }

    if (!this.apiKey) {
      throw new Error("Gemini API is not configured: GEMINI_API_KEY is missing.");
    }

    return this.schedule(async () => {
      try {
        const result = await this.runConversation(request.prompt, this.resolveModelName(request.execution?.preset));
        return {
          provider: this.name,
          startedAt: new Date(),
          meta: result,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isGeminiQuotaError(msg)) {
          this.cooldownUntil = Date.now() + 60_000;
        }
        throw new Error(formatGeminiApiErrorMessage(msg));
      }
    });
  }

  async waitForCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion> {
    return {
      provider: handle.provider,
      completedAt: new Date(),
      meta: handle.meta,
    };
  }

  async extractAnswer(completion: ProviderCompletion): Promise<ProviderRunResult> {
    const meta = (completion.meta ?? {}) as unknown as GeminiHandleMeta;
    const text = meta.responseText || "Gemini API returned no answer.";
    return {
      provider: this.name,
      outputText: text,
      summary: this.summarize(text),
      meta: {
        ...(meta.functionCallResults ? { functionCalls: meta.functionCallResults } : {}),
        ...(meta.model ? { model: meta.model } : {}),
      },
    };
  }

  manualRecoveryHint(): string {
    return buildGeminiApiRecoveryHint();
  }

  private async runConversation(prompt: string, modelName: string): Promise<GeminiHandleMeta> {
    const history: GeminiContent[] = [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ];
    const functionCallResults: string[] = [];
    let latestText = "";

    for (let round = 0; round < 4; round += 1) {
      const response = await this.requestContent(history, modelName);
      const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
      if (candidateParts.length === 0) {
        break;
      }

      history.push({
        role: "model",
        parts: candidateParts,
      });

      const text = extractTextParts(candidateParts);
      if (text) {
        latestText = text;
      }

      const functionCalls = candidateParts.filter((part) => part.functionCall);
      if (functionCalls.length === 0) {
        break;
      }

      const toolResponses: GeminiContentPart[] = [];
      for (const part of functionCalls) {
        const call = part.functionCall;
        if (!call) {
          continue;
        }

        const callResult = await this.executeLocalTool(
          call.name,
          normalizeToolArgs(call.args),
        );
        functionCallResults.push(`${call.name}: ${callResult}`);
        toolResponses.push({
          functionResponse: {
            name: call.name,
            response: { result: callResult },
          },
        });
      }

      if (toolResponses.length === 0) {
        break;
      }

      history.push({
        role: "user",
        parts: toolResponses,
      });
    }

    return {
      responseText: latestText || functionCallResults.join("\n") || "Gemini API returned no answer.",
      functionCallResults: functionCallResults.length > 0 ? functionCallResults : undefined,
      model: modelName,
    };
  }

  private async requestContent(contents: GeminiContent[], modelName: string): Promise<GeminiGenerateContentResponse> {
    const payload = {
      contents,
      tools: [{ functionDeclarations: localToolDeclarations }],
      systemInstruction: {
        parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }],
      },
    };

    const { status, body } = await postGeminiRequest(buildGeminiApiEndpoint(modelName), payload, this.apiKey);
    const response = safeParseGeminiResponse(body);

    if (status >= 400 || response.error) {
      const message = response.error?.message || body || `HTTP ${status}`;
      throw new Error(`Gemini API request failed (${status}): ${message}`);
    }

    return response;
  }

  private resolveModelName(preset?: ModelPresetName): string {
    if (preset === "deep") {
      return process.env.GEMINI_API_MODEL_DEEP ?? process.env.GEMINI_API_MODEL_EXPERT ?? process.env.GEMINI_API_MODEL_PRO ?? "gemini-2.5-flash";
    }
    if (preset === "expert") {
      return process.env.GEMINI_API_MODEL_EXPERT ?? process.env.GEMINI_API_MODEL_PRO ?? "gemini-2.5-flash";
    }
    if (preset === "pro") {
      return process.env.GEMINI_API_MODEL_PRO ?? "gemini-2.5-flash";
    }
    return process.env.GEMINI_API_MODEL_STANDARD ?? process.env.GEMINI_API_MODEL ?? this.defaultModelName;
  }

  private async executeLocalTool(name: string, args: Record<string, string>): Promise<string> {
    try {
      switch (name) {
        case "createFolder":
          return await this.toolCreateFolder(args.path);
        case "moveFile":
          return await this.toolMoveFile(args.src, args.dst);
        case "writeFile":
          return await this.toolWriteFile(args.path, args.content);
        case "listDir":
          return await this.toolListDir(args.path);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private resolveSafe(relativePath: string): string {
    const absolute = resolve(this.workspaceRoot, relativePath);
    if (!absolute.startsWith(this.workspaceRoot)) {
      throw new Error("Path traversal blocked: path must stay within workspace root.");
    }
    return absolute;
  }

  private async toolCreateFolder(path: string): Promise<string> {
    const absolute = this.resolveSafe(path);
    await mkdir(absolute, { recursive: true });
    return `Folder created: ${path}`;
  }

  private async toolMoveFile(src: string, dst: string): Promise<string> {
    const absSrc = this.resolveSafe(src);
    const absDst = this.resolveSafe(dst);
    await mkdir(dirname(absDst), { recursive: true });
    await rename(absSrc, absDst);
    return `Moved ${src} -> ${dst}`;
  }

  private async toolWriteFile(path: string, content: string): Promise<string> {
    const absolute = this.resolveSafe(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    return `File written: ${path} (${content.length} chars)`;
  }

  private async toolListDir(path: string): Promise<string> {
    const absolute = this.resolveSafe(path);
    const entries = await readdir(absolute);
    const results: string[] = [];
    for (const entry of entries.slice(0, 20)) {
      const entryPath = join(absolute, entry);
      const entryStat = await stat(entryPath).catch(() => null);
      results.push(entryStat?.isDirectory() ? `${entry}/` : entry);
    }
    return results.join(", ") || "(empty directory)";
  }
}

export function buildGeminiApiEndpoint(modelName: string): string {
  const normalizedModel = modelName.startsWith("models/") ? modelName : `models/${modelName}`;
  return `${GEMINI_API_BASE_URL}/${normalizedModel}:generateContent`;
}

async function postGeminiRequest(
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
): Promise<{ status: number; body: string }> {
  try {
    return await postGeminiRequestWithCurl(url, payload, apiKey);
  } catch (error) {
    if (!isMissingCommandError(error)) {
      throw error;
    }

    return postGeminiRequestWithFetch(url, payload, apiKey);
  }
}

async function postGeminiRequestWithCurl(
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "-sS",
      "-X",
      "POST",
      url,
      "-H",
      "Content-Type: application/json",
      "-H",
      `X-Goog-Api-Key: ${apiKey}`,
      "--connect-timeout",
      "15",
      "--max-time",
      "90",
      "--data-binary",
      "@-",
      "-w",
      "\n__HTTP_STATUS__:%{http_code}",
    ];

    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      args.unshift("-k");
    }

    const child = spawn("curl", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || stdout.trim() || `curl exited with code ${code}`));
        return;
      }

      const marker = "\n__HTTP_STATUS__:";
      const markerIndex = stdout.lastIndexOf(marker);
      if (markerIndex === -1) {
        rejectPromise(new Error("curl completed without an HTTP status marker."));
        return;
      }

      const body = stdout.slice(0, markerIndex).trim();
      const status = Number.parseInt(stdout.slice(markerIndex + marker.length).trim(), 10);
      resolvePromise({
        status: Number.isFinite(status) ? status : 0,
        body,
      });
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function postGeminiRequestWithFetch(
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });

  return {
    status: response.status,
    body: await response.text(),
  };
}

function safeParseGeminiResponse(body: string): GeminiGenerateContentResponse {
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as GeminiGenerateContentResponse;
  } catch {
    return {
      error: {
        message: body,
      },
    };
  }
}

function normalizeToolArgs(args: Record<string, unknown> | undefined): Record<string, string> {
  if (!args) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
  );
}

function extractTextParts(parts: GeminiContentPart[]): string {
  return parts
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isMissingCommandError(error: unknown): boolean {
  return error instanceof Error && /ENOENT|spawn .*? ENOENT/i.test(error.message);
}

function isGeminiQuotaError(message: string): boolean {
  return /429|RESOURCE_EXHAUSTED|quota|capacity/i.test(message);
}

function formatGeminiApiErrorMessage(message: string): string {
  const normalized = message.trim();
  if (!/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|curl|proxy|timed out/i.test(normalized)) {
    return normalized;
  }

  const hints: string[] = [];
  if (hasConfiguredProxy()) {
    hints.push("Detected HTTP(S)_PROXY/ALL_PROXY in the runtime environment.");
    hints.push("This provider now prefers curl for outbound requests so local proxy settings can be honored.");
  }
  hints.push("Check direct DNS/connectivity to generativelanguage.googleapis.com and verify the local proxy is reachable from the server process.");
  return [normalized, ...hints].join(" ");
}

function buildGeminiApiRecoveryHint(message?: string): string {
  const hints = ["Check GEMINI_API_KEY in .env and verify outbound access to generativelanguage.googleapis.com."];
  if (hasConfiguredProxy()) {
    hints.push("Proxy env vars are present; make sure the configured local proxy port is reachable from the server process.");
  }
  if (message && isGeminiQuotaError(message)) {
    hints.push("If the request reached Gemini, this specific failure is quota/capacity-related rather than a missing key.");
  }
  return hints.join(" ");
}

function hasConfiguredProxy(): boolean {
  return Boolean(
    process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || process.env.ALL_PROXY
      || process.env.all_proxy,
  );
}
