import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  AuditEngine,
  loadPromptCatalog,
  loadProviderConfig,
  loadRoleConfig,
  loadRoutingPolicy,
  loadSkillConfig,
  MonitorHub,
  ProviderRegistry,
  RoleRegistry,
  safeJsonParse,
  SkillRegistry,
  TaskOrchestrator,
} from "@office-agent/core";
import { LocalCodexRunner } from "@office-agent/codex-runner";
import { DocMarkdownExecutor, ImagePromptExecutor, PptMarkdownExecutor, VideoPlanExecutor } from "@office-agent/executors";
import { FeishuBotApp, FeishuNotifier, NoopNotifier } from "@office-agent/feishu";
import { LocalAccessLayer } from "@office-agent/local-access";
import { PrismaTaskStore } from "@office-agent/storage";
import { ConfigHotReloader } from "./config-hot-reloader";
import type { ServerApprovalPolicy, ServerExtension, ServerExtensionSetupContext } from "./extensions";
import { createProvider } from "./provider-factory";
import { ServerTaskNotifier } from "./notifier";
import { loadEnv, type AppEnv } from "./env";
import { PushScheduler } from "./scheduler";
import { createTaskActionController, type TaskActionController } from "./task-actions";

export type { ServerApprovalPolicy, ServerExtension, ServerExtensionSetupContext } from "./extensions";

export interface AppServices {
  env: AppEnv;
  app: FastifyInstance;
  store: PrismaTaskStore;
  registry: ProviderRegistry;
  orchestrator: TaskOrchestrator;
  monitor: MonitorHub;
  feishuBot: FeishuBotApp;
  scheduler: PushScheduler | null;
  configHotReloader: ConfigHotReloader | null;
  prisma: ReturnType<typeof PrismaTaskStore.createClient>;
  taskController: TaskActionController;
  extensions: ServerExtension[];
}

export async function createServices(
  cwd = process.cwd(),
  options?: {
    startFeishuLongConnection?: boolean;
    startScheduler?: boolean;
    extensions?: ServerExtension[];
  },
): Promise<AppServices> {
  const env = loadEnv(cwd);
  const app = Fastify({
    logger: {
      level: env.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers['set-cookie']",
          "body.app_secret",
          "body.tenant_access_token",
        ],
        censor: "[redacted]",
      },
    },
  });
  const providerConfig = await loadProviderConfig(env.configDir);
  const routingPolicy = await loadRoutingPolicy(env.configDir);
  const roleConfig = await loadRoleConfig(env.configDir);
  const skillConfig = await loadSkillConfig(env.configDir);
  const prompts = await loadPromptCatalog(env.configDir);
  const extensions = options?.extensions ?? [];
  const extensionContext: ServerExtensionSetupContext = {
    cwd,
    app,
    env,
    providerConfig,
    routingPolicy,
    roleConfig,
    skillConfig,
    prompts,
  };

  const prisma = PrismaTaskStore.createClient();
  const store = new PrismaTaskStore(prisma);
  await ensureDefaultApprovalPolicies(
    store,
    extensions.flatMap((extension) => extension.approvalPolicies ?? []),
  );

  const extensionProviders = (await Promise.all(
    extensions.map(async (extension) => extension.createProviders?.(extensionContext) ?? []),
  )).flat();
  const providers = [
    ...providerConfig.providers.map((config) => createProvider(config, env.configDir, env.screenshotDir)),
    ...extensionProviders,
  ];
  const registry = new ProviderRegistry(providers, store);

  const bootstrapNotifier = env.feishu.webhookUrl ? new FeishuNotifier(env.feishu) : new NoopNotifier();
  const extensionNotifiers = (await Promise.all(
    extensions.map(async (extension) => extension.createNotifiers?.(extensionContext) ?? []),
  )).flat();
  const notifier = new ServerTaskNotifier(bootstrapNotifier, undefined, extensionNotifiers);

  const codexRunner = new LocalCodexRunner({
    enabled: env.codex.enabled,
    mode: env.codex.mode,
    command: env.codex.command,
    args: env.codex.args,
    gemini: env.geminiRunner,
    artifactRootDir: env.taskArtifactDir,
    workspaceRoot: env.localAccess.workspaceRoot,
  });

  const localAccess = new LocalAccessLayer({
    workspaceRoot: env.localAccess.workspaceRoot,
    codexCli: env.localAccess.codex,
    geminiCli: env.localAccess.gemini,
  });
  const extensionExecutors = (await Promise.all(
    extensions.map(async (extension) => extension.createExecutors?.(extensionContext) ?? []),
  )).flat();
  const executors = [
    new DocMarkdownExecutor({ artifactRootDir: env.taskArtifactDir }),
    new ImagePromptExecutor({ artifactRootDir: env.taskArtifactDir }),
    new PptMarkdownExecutor({ artifactRootDir: env.taskArtifactDir }),
    new VideoPlanExecutor({ artifactRootDir: env.taskArtifactDir }),
    ...extensionExecutors,
  ];
  const roleRegistry = new RoleRegistry(roleConfig.roles);
  const skillRegistry = new SkillRegistry(skillConfig.skills);
  const auditEngine = new AuditEngine();
  const monitor = new MonitorHub();
  const orchestrator = new TaskOrchestrator(
    store,
    registry,
    routingPolicy,
    prompts,
    notifier,
    codexRunner,
    localAccess,
    executors,
    {
      roleRegistry,
      skillRegistry,
      auditEngine,
      monitor,
    },
  );
  const feishuBot = new FeishuBotApp(env.feishu, orchestrator, store, {
    workspaceRoot: env.localAccess.workspaceRoot,
    auditConfirmTimeoutMs: 10_000,
  });
  const taskController = createTaskActionController({ store, monitor, prisma, codexRunner, notifier });
  feishuBot.setTaskController(taskController);
  const scheduler = env.scheduler.enabled ? new PushScheduler(env, orchestrator, store, feishuBot, app.log) : null;
  const shouldStartScheduler = options?.startScheduler ?? false;
  let configHotReloader: ConfigHotReloader | null = null;
  if (env.config.hotReload) {
    configHotReloader = new ConfigHotReloader(env.configDir, roleRegistry, skillRegistry, monitor, app.log);
    configHotReloader.start();
    app.log.info("Role/skill YAML hot reload enabled.");
  }
  notifier.setFeishuBot(feishuBot);
  if (shouldStartScheduler) {
    scheduler?.start();
  }
  if ((options?.startFeishuLongConnection ?? true) && env.feishu.useLongConnection) {
    try {
      await feishuBot.startLongConnection();
      app.log.info("Feishu long connection mode started.");
    } catch (error) {
      app.log.error({ err: error }, "Failed to start Feishu long connection mode");
    }
  }

  const recentTasks = await store.listTasks(20);
  for (const recentTask of recentTasks) {
    const hydrated = await store.getTask(recentTask.id);
    if (!hydrated) {
      continue;
    }
    const sourceMeta = (hydrated.sourceMeta ?? {}) as Record<string, unknown>;
    const workflow =
      sourceMeta.workflow && typeof sourceMeta.workflow === "object"
        ? safeJsonParse(JSON.stringify(sourceMeta.workflow), undefined as Record<string, unknown> | undefined)
        : undefined;
    monitor.recordTask(hydrated, workflow as any);
  }

  const services: AppServices = {
    env,
    app,
    store,
    registry,
    orchestrator,
    monitor,
    feishuBot,
    scheduler,
    configHotReloader,
    prisma,
    taskController,
    extensions,
  };

  for (const extension of extensions) {
    await extension.onServicesCreated?.(services);
  }

  return services;
}

async function ensureDefaultApprovalPolicies(
  store: PrismaTaskStore,
  extraPolicies: ServerApprovalPolicy[] = [],
): Promise<void> {
  await Promise.all([
    store.upsertApprovalPolicy({
      key: "cli_authorization",
      name: "CLI 授权续跑",
      description: "当 Codex/Gemini CLI 需要继续授权时，进入人工审批。",
      mode: "manual",
      priority: 10,
      matchTaskTypes: ["CODING"],
      matchRunners: ["codex", "gemini"],
    }),
    store.upsertApprovalPolicy({
      key: "desktop_control",
      name: "桌面控制观察",
      description: "涉及截图、打开目录、桌面操作时记录审批计划，便于在控制台追踪。",
      mode: "observe",
      priority: 30,
      matchKeywords: ["截图", "桌面", "打开", "文件夹", "目录"],
    }),
    store.upsertApprovalPolicy({
      key: "filesystem_write",
      name: "工程写入观察",
      description: "涉及代码修改、写文件、重构时进入工程写入观察策略。",
      mode: "observe",
      priority: 40,
      matchTaskTypes: ["CODING"],
      matchKeywords: ["修改", "编辑", "修复", "实现", "重构", "新增", "删除", "rename", "edit", "fix", "implement"],
    }),
    store.upsertApprovalPolicy({
      key: "model_upgrade",
      name: "高阶模型升级",
      description: "明确要求切换更强模型时保留审批记录。",
      mode: "manual",
      priority: 60,
      matchKeywords: ["专家模式", "更好的模型", "更强模型", "升级模型", "高级模型"],
    }),
    ...extraPolicies.map((policy) => store.upsertApprovalPolicy(policy)),
  ]).catch(() => undefined);
}
