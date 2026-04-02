import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { CodexRunner, CodingArtifacts, CodingHandoffBundle } from "@office-agent/core";
import { prepareGeminiCliArgs, prepareGeminiCliEnv } from "@office-agent/core";

export interface CodexRunnerOptions {
  enabled: boolean;
  mode: "artifacts_only" | "cli";
  command: string;
  args: string[];
  gemini?: {
    enabled: boolean;
    command: string;
    args: string[];
  };
  artifactRootDir: string;
  workspaceRoot: string;
}

export class LocalCodexRunner implements CodexRunner {
  constructor(private readonly options: CodexRunnerOptions) {}

  async isAvailable(): Promise<boolean> {
    const runners = this.listConfiguredRunners();
    if (runners.length === 0) {
      return false;
    }

    const availability = await Promise.all(runners.map((runner) => commandExists(runner.command)));
    return availability.some(Boolean);
  }

  async createArtifacts(bundle: CodingHandoffBundle): Promise<CodingArtifacts> {
    const taskDir = resolve(this.options.artifactRootDir, bundle.taskId);
    await mkdir(taskDir, { recursive: true });

    const files = {
      implementationBriefPath: join(taskDir, "implementation_brief.md"),
      implementationPlanPath: join(taskDir, "implementation_plan.json"),
      acceptanceChecklistPath: join(taskDir, "acceptance_checklist.md"),
      contextSummaryPath: join(taskDir, "context_summary.md"),
      codexTaskPath: join(taskDir, "codex_task.md"),
    };

    await Promise.all([
      writeFile(files.implementationBriefPath, renderImplementationBrief(bundle), "utf8"),
      writeFile(files.implementationPlanPath, JSON.stringify(bundle, null, 2), "utf8"),
      writeFile(files.acceptanceChecklistPath, renderAcceptanceChecklist(bundle), "utf8"),
      writeFile(files.contextSummaryPath, renderContextSummary(bundle), "utf8"),
      writeFile(files.codexTaskPath, renderCodexTask(bundle, taskDir), "utf8"),
    ]);

    return {
      taskDir,
      ...files,
    };
  }

  async run(bundle: CodingHandoffBundle, artifacts: CodingArtifacts): Promise<{
    stdout: string;
    stderr: string;
    success: boolean;
    sessionId?: string;
  }> {
    if (this.options.mode !== "cli") {
      return {
        stdout: "",
        stderr: "Codex runner mode is artifacts_only.",
        success: false,
      };
    }

    const preferred = inferPreferredRunner(bundle);
    const runner = await this.resolveRunner(bundle);
    if (!runner) {
      return {
        stdout: "",
        stderr:
          preferred === "gemini"
            ? "Gemini CLI is not available in the current environment. Please install it or correct GEMINI_COMMAND."
            : "No supported local coding CLI is available in the current environment.",
        success: false,
      };
    }

    const prompt = await readFile(artifacts.codexTaskPath, "utf8");
    if (runner.kind === "codex") {
      return runCodexJsonSession({
        command: runner.command,
        args: [
          "exec",
          ...runner.args,
          "--json",
          ...(shouldUseReadOnlySandbox(bundle) ? ["-s", "read-only"] : []),
          "--skip-git-repo-check",
          "-C",
          this.options.workspaceRoot,
          "--color",
          "never",
          "-",
        ],
        cwd: this.options.workspaceRoot,
        prompt,
      });
    }

    const env = prepareGeminiCliEnv(this.options.workspaceRoot);
    await ensureCliHome(env.GEMINI_CLI_HOME);

    return runPlainCliSession({
      command: runner.command,
      args: prepareGeminiCliArgs(runner.args, env),
      cwd: this.options.workspaceRoot,
      prompt,
      env,
      timeoutMs: runner.kind === "gemini" ? 90_000 : 120_000,
    });
  }

  async resume(input: {
    sessionId: string;
    prompt: string;
  }): Promise<{
    stdout: string;
    stderr: string;
    success: boolean;
    sessionId?: string;
  }> {
    if (!this.options.enabled || !await commandExists(this.options.command)) {
      return {
        stdout: "",
        stderr: "Codex CLI is not available in the current environment.",
        success: false,
      };
    }

    return runCodexJsonSession({
      command: this.options.command,
      args: [
        "exec",
        "resume",
        "--json",
        input.sessionId,
        "-",
      ],
      cwd: this.options.workspaceRoot,
      prompt: input.prompt,
    });
  }

  private listConfiguredRunners(): Array<{ kind: "codex" | "gemini"; command: string; args: string[] }> {
    const runners: Array<{ kind: "codex" | "gemini"; command: string; args: string[] }> = [];

    if (this.options.enabled) {
      runners.push({
        kind: "codex",
        command: this.options.command,
        args: this.options.args,
      });
    }

    if (this.options.gemini?.enabled) {
      runners.push({
        kind: "gemini",
        command: this.options.gemini.command,
        args: this.options.gemini.args,
      });
    }

    return runners;
  }

  private async resolveRunner(
    bundle: CodingHandoffBundle,
  ): Promise<{ kind: "codex" | "gemini"; command: string; args: string[] } | null> {
    const preferred = inferPreferredRunner(bundle);
    const configured = this.listConfiguredRunners();
    const preferredRunner = configured.find((runner) => runner.kind === preferred);

    if (preferredRunner && await commandExists(preferredRunner.command)) {
      return preferredRunner;
    }

    if (preferredRunner && shouldStrictlyUseRunner(bundle, preferred)) {
      return null;
    }

    for (const runner of configured) {
      if (await commandExists(runner.command)) {
        return runner;
      }
    }

    return null;
  }
}

function renderImplementationBrief(bundle: CodingHandoffBundle): string {
  return [
    `# Implementation Brief`,
    ``,
    `## Task Goal`,
    bundle.originalRequest,
    ``,
    `## Final Plan`,
    bundle.finalPlan,
    ``,
    `## Candidate Plans`,
    ...bundle.candidatePlans.map((plan) => `- ${plan.provider}: ${plan.plan}`),
    ``,
    `## Impacted Files`,
    ...bundle.impactedFiles.map((file) => `- ${file}`),
    ``,
    `## Risks`,
    ...bundle.risks.map((risk) => `- ${risk}`),
    ``,
    `## Open Questions`,
    ...bundle.unresolvedQuestions.map((question) => `- ${question}`),
    ``,
  ].join("\n");
}

function renderAcceptanceChecklist(bundle: CodingHandoffBundle): string {
  return [
    `# Acceptance Checklist`,
    ``,
    `- [ ] 完成 ${bundle.taskId} 对应实现`,
    ...bundle.testingSuggestions.map((item) => `- [ ] ${item}`),
    `- [ ] 输出最终交付摘要`,
    ``,
  ].join("\n");
}

function renderContextSummary(bundle: CodingHandoffBundle): string {
  return [
    `# Context Summary`,
    ``,
    `## Original Request`,
    bundle.originalRequest,
    ``,
    `## Final Plan`,
    bundle.finalPlan,
    ``,
    `## Risks`,
    ...bundle.risks.map((risk) => `- ${risk}`),
    ``,
  ].join("\n");
}

function renderCodexTask(bundle: CodingHandoffBundle, taskDir: string): string {
  return [
    `# Local CLI Task`,
    ``,
    `请根据以下内容在本地仓库中直接执行实现，并运行必要测试。`,
    `如果产出截图、图片、文档等文件，请优先保存到这个任务产物目录：${taskDir}`,
    `如果任务要求“截图当前桌面”或其他可视化结果，请直接生成文件，不要只描述操作步骤。`,
    ``,
    `## 原始需求`,
    bundle.originalRequest,
    ``,
    `## 最终实施方案`,
    bundle.finalPlan,
    ``,
    `## 候选方案`,
    ...bundle.candidatePlans.map((plan) => `- ${plan.provider}: ${plan.plan}`),
    ``,
    `## 风险点`,
    ...bundle.risks.map((risk) => `- ${risk}`),
    ``,
    `## 测试建议`,
    ...bundle.testingSuggestions.map((item) => `- ${item}`),
    ``,
  ].join("\n");
}

function inferPreferredRunner(bundle: CodingHandoffBundle): "codex" | "gemini" {
  if (bundle.explicitRunner) {
    return bundle.explicitRunner;
  }

  const providerHints = bundle.candidatePlans.map((plan) => plan.provider).join("\n").toLowerCase();
  if (providerHints.includes("gemini")) {
    return "gemini";
  }
  if (/(gemini|谷歌)/iu.test(`${bundle.originalRequest}\n${bundle.finalPlan}`)) {
    return "gemini";
  }
  return "codex";
}

function shouldStrictlyUseRunner(bundle: CodingHandoffBundle, preferred: "codex" | "gemini"): boolean {
  const text = `${bundle.originalRequest}\n${bundle.finalPlan}`.toLowerCase();
  if (preferred === "gemini") {
    return /gemini|谷歌/u.test(text);
  }
  return /codex/u.test(text);
}

function shouldUseReadOnlySandbox(bundle: CodingHandoffBundle): boolean {
  const input = `${bundle.originalRequest}\n${bundle.finalPlan}`.toLowerCase();
  return !/(修改|编辑|修复|实现|重构|新增|创建|删除|重命名|写入|改代码|fix|edit|modify|implement|refactor|create|delete|rename|write)/iu.test(input);
}

async function runPlainCliSession(input: {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  success: boolean;
  sessionId?: string;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = input.timeoutMs ?? 120_000;
    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolvePromise({
        stdout,
        stderr: `${stderr}\nCLI execution timed out after ${Math.round(timeoutMs / 1000)}s.`,
        success: false,
      });
    }, timeoutMs);

    function finish(payload: {
      stdout: string;
      stderr: string;
      success: boolean;
      sessionId?: string;
    }): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolvePromise(payload);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      const success = code === 0 && !containsPlainCliFatalError(stderr || stdout);
      finish({
        stdout,
        stderr,
        success,
      });
    });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: `${stderr}\n${error.message}`,
        success: false,
      });
    });

    child.stdin.write(input.prompt);
    child.stdin.end();
  });
}

async function ensureCliHome(cliHome: string | undefined): Promise<void> {
  if (!cliHome) {
    return;
  }

  await mkdir(cliHome, { recursive: true });
}

function containsPlainCliFatalError(raw: string): boolean {
  const normalized = raw.toLowerCase();
  const markers = [
    "no capacity available",
    "model_capacity_exhausted",
    "resource_exhausted",
    "gaxioserror",
    "premature close",
    "unexpected critical error",
    "max attempts reached",
    "permission denied",
    "operation not permitted",
  ];
  return markers.some((marker) => normalized.includes(marker));
}

async function runCodexJsonSession(input: {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
}): Promise<{
  stdout: string;
  stderr: string;
  success: boolean;
  sessionId?: string;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let sessionId: string | undefined;
    let pendingLine = "";
    const messages: string[] = [];
    const commandLogs: string[] = [];

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;

      pendingLine += text;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
            sessionId = parsed.thread_id;
            continue;
          }

          if (parsed.type !== "item.completed" && parsed.type !== "item.started") {
            continue;
          }

          const item = parsed.item;
          if (!item || typeof item !== "object") {
            continue;
          }

          const entry = item as Record<string, unknown>;
          if (entry.type === "agent_message" && typeof entry.text === "string") {
            messages.push(entry.text.trim());
            continue;
          }

          if (entry.type === "command_execution") {
            const aggregatedOutput = typeof entry.aggregated_output === "string" ? entry.aggregated_output.trim() : "";
            const command = typeof entry.command === "string" ? entry.command : "";
            const status = typeof entry.status === "string" ? entry.status : "";
            if (command || aggregatedOutput) {
              commandLogs.push(
                [command ? `命令: ${command}` : "", status ? `状态: ${status}` : "", aggregatedOutput ? `输出: ${aggregatedOutput}` : ""]
                  .filter(Boolean)
                  .join("\n"),
              );
            }
          }
        } catch {
          continue;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (pendingLine.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(pendingLine.trim()) as Record<string, unknown>;
          if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
            sessionId = parsed.thread_id;
          }
        } catch {
          // Ignore a trailing partial line.
        }
      }
      resolvePromise({
        stdout: [...messages.slice(-2), ...commandLogs.slice(-2)].filter(Boolean).join("\n\n").trim() || stdout,
        stderr,
        success: code === 0,
        sessionId,
      });
    });
    child.on("error", (error) => {
      resolvePromise({
        stdout: [...messages.slice(-2), ...commandLogs.slice(-2)].filter(Boolean).join("\n\n").trim() || stdout,
        stderr: `${stderr}\n${error.message}`,
        success: false,
        sessionId,
      });
    });

    child.stdin.write(input.prompt);
    child.stdin.end();
  });
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
