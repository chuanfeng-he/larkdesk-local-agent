import { readdir, readFile, stat, mkdir, writeFile as fsWriteFile, rename } from "node:fs/promises";
import { basename, extname, resolve, relative } from "node:path";
import { spawn } from "node:child_process";
import type { LocalAccessRequest, LocalAccessResult, LocalAccessService } from "@office-agent/core";
import { prepareGeminiCliArgs, prepareGeminiCliEnv, summarizeText } from "@office-agent/core";

export interface LocalAccessLayerOptions {
  workspaceRoot: string;
  codexCli?: CliAccessOptions;
  geminiCli?: CliAccessOptions;
}

export interface CliAccessOptions {
  mode: "disabled" | "stdin";
  command: string;
  args: string[];
}

export class LocalAccessLayer implements LocalAccessService {
  private readonly readers: LocalAccessReader[];

  constructor(private readonly options: LocalAccessLayerOptions) {
    this.readers = [
      new CliLocalAccessReader("codex_cli", options.workspaceRoot, options.codexCli),
      new CliLocalAccessReader("gemini_cli", options.workspaceRoot, options.geminiCli),
      new NativeLocalAccessReader(options.workspaceRoot),
    ];
  }

  async gatherContext(input: LocalAccessRequest): Promise<LocalAccessResult> {
    for (const reader of this.readers) {
      const result = await reader.read(input);
      if (result) {
        return result;
      }
    }

    return {
      backend: "native_reader",
      summary: "No local context was available.",
      referencedPaths: [],
      notes: ["All local access readers returned no data."],
    };
  }

  async createDirectory(dirPath: string): Promise<{ success: boolean; error?: string }> {
    const safe = this.resolveSafe(dirPath);
    if (!safe) {
      return { success: false, error: "Path escapes workspace root" };
    }
    try {
      await mkdir(safe, { recursive: true });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }

  async writeFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    const safe = this.resolveSafe(filePath);
    if (!safe) {
      return { success: false, error: "Path escapes workspace root" };
    }
    try {
      const dir = resolve(safe, "..");
      await mkdir(dir, { recursive: true });
      await fsWriteFile(safe, content, "utf8");
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }

  async moveFile(srcPath: string, destPath: string): Promise<{ success: boolean; error?: string }> {
    const safeSrc = this.resolveSafe(srcPath);
    const safeDest = this.resolveSafe(destPath);
    if (!safeSrc || !safeDest) {
      return { success: false, error: "Path escapes workspace root" };
    }
    try {
      const destDir = resolve(safeDest, "..");
      await mkdir(destDir, { recursive: true });
      await rename(safeSrc, safeDest);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }

  private resolveSafe(targetPath: string): string | null {
    const abs = resolve(this.options.workspaceRoot, targetPath);
    const rel = relative(this.options.workspaceRoot, abs);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      return null;
    }
    return abs;
  }
}

interface LocalAccessReader {
  read(input: LocalAccessRequest): Promise<LocalAccessResult | null>;
}

class CliLocalAccessReader implements LocalAccessReader {
  constructor(
    private readonly backend: "codex_cli" | "gemini_cli",
    private readonly workspaceRoot: string,
    private readonly options?: CliAccessOptions,
  ) {}

  async read(input: LocalAccessRequest): Promise<LocalAccessResult | null> {
    if (!this.options || this.options.mode === "disabled") {
      return null;
    }

    const available = await commandExists(this.options.command);
    if (!available) {
      return null;
    }

    const prompt = buildCliPrompt(input);
    const env = this.backend === "gemini_cli" ? prepareGeminiCliEnv(this.workspaceRoot) : undefined;
    await ensureCliHome(env?.GEMINI_CLI_HOME);
    const args = this.backend === "gemini_cli" ? prepareGeminiCliArgs(this.options.args, env) : this.options.args;
    const output = await runCliPrompt(this.options.command, args, prompt, this.workspaceRoot, env);
    if (!output) {
      return null;
    }

    return {
      backend: this.backend,
      summary: summarizeText(output, 2_000),
      referencedPaths: [],
      notes: [`Resolved by ${this.backend}.`],
    };
  }
}

class NativeLocalAccessReader implements LocalAccessReader {
  constructor(private readonly workspaceRoot: string) {}

  async read(input: LocalAccessRequest): Promise<LocalAccessResult | null> {
    const candidates = await resolveRelevantPaths(input, this.workspaceRoot);
    if (candidates.length === 0) {
      return {
        backend: "native_reader",
        summary: "No explicit local files were referenced. Falling back to repository overview only.",
        referencedPaths: [],
        notes: ["No path-like tokens detected in the request."],
      };
    }

    const chunks: string[] = [];
    for (const filePath of candidates.slice(0, input.maxEntries ?? 8)) {
      const absolutePath = resolve(this.workspaceRoot, filePath);
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat) {
        continue;
      }

      if (fileStat.isDirectory()) {
        const entries = await readdir(absolutePath).catch(() => []);
        chunks.push(`目录 ${filePath}: ${entries.slice(0, 12).join(", ")}`);
        continue;
      }

      const extension = extname(absolutePath).toLowerCase();
      if (!isReadableTextFile(extension)) {
        chunks.push(`文件 ${filePath}: binary or unsupported text type`);
        continue;
      }

      const content = await readFile(absolutePath, "utf8").catch(() => "");
      chunks.push(`文件 ${filePath}:\n${summarizeText(content, 1_400)}`);
    }

    if (chunks.length === 0) {
      return null;
    }

    return {
      backend: "native_reader",
      summary: summarizeText(chunks.join("\n\n"), 4_000),
      referencedPaths: candidates,
      notes: ["Resolved by native local reader fallback."],
    };
  }
}

async function resolveRelevantPaths(input: LocalAccessRequest, workspaceRoot: string): Promise<string[]> {
  const explicit = extractPathHints(input.input);
  if (explicit.length > 0) {
    return explicit;
  }

  if (input.taskType === "CODING" || /仓库|repo|项目|代码库/.test(input.input)) {
    const entries = await readdir(workspaceRoot).catch(() => []);
    return entries
      .filter((entry) => !entry.startsWith("."))
      .slice(0, input.maxEntries ?? 8);
  }

  return [];
}

function extractPathHints(input: string): string[] {
  const hinted = new Set<string>();
  const backtickMatches = input.match(/`([^`]+)`/g) ?? [];
  for (const match of backtickMatches) {
    const cleaned = match.slice(1, -1).trim();
    if (cleaned) {
      hinted.add(cleaned);
    }
  }

  const pathMatches = input.match(/(?:\.\/|\.\.\/|\/)?[A-Za-z0-9._/-]+\.[A-Za-z0-9._-]+/g) ?? [];
  for (const match of pathMatches) {
    hinted.add(match.trim());
  }

  return [...hinted];
}

function isReadableTextFile(extension: string): boolean {
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".txt",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".css",
    ".html",
  ].includes(extension);
}

function buildCliPrompt(input: LocalAccessRequest): string {
  return [
    "你是本地访问层，只负责读取本地文件/目录/仓库并总结上下文，不要编造不存在的文件。",
    `任务ID: ${input.taskId}`,
    `任务类型: ${input.taskType}`,
    `任务意图: ${input.intent}`,
    `工作区: ${basename(input.workspaceRoot)}`,
    `用户请求: ${input.input}`,
    "请返回：",
    "1. 涉及到的本地路径",
    "2. 关键文件摘要",
    "3. 与任务最相关的实现/文档线索",
  ].join("\n");
}

async function runCliPrompt(
  command: string,
  args: string[],
  prompt: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("exit", (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolvePromise(null);
        return;
      }

      resolvePromise(`${stdout.trim()}\n${stderr ? `\n[stderr]\n${stderr.trim()}` : ""}`.trim());
    });
  });
}

async function ensureCliHome(cliHome: string | undefined): Promise<void> {
  if (!cliHome) {
    return;
  }

  await mkdir(cliHome, { recursive: true });
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-lc", `command -v ${command}`], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolvePromise(code === 0));
    child.on("error", () => resolvePromise(false));
  });
}
