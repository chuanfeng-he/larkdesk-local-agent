import { z } from "zod";
import { hashContent, summarizeText } from "@office-agent/core";
import { FeishuNotifier } from "@office-agent/feishu";
import type { FastifyInstance } from "fastify";
import { createServices } from "./bootstrap";
import { buildControlConsoleHtml } from "./control-console";
import type { ServerExtension } from "./extensions";
import { buildMonitorDashboardHtml, MonitorDiagnosticsBridge } from "./monitor-bridge";

const submitTaskSchema = z.object({
  input: z.string().min(1),
  requestedType: z.enum(["SIMPLE", "COMPLEX", "CODING"]).optional(),
  requestedIntent: z.enum(["qa", "office_discussion", "doc", "ppt", "image", "video", "coding"]).optional(),
  budget: z.enum(["low", "standard", "high"]).optional(),
  artifactType: z.enum(["none", "doc", "ppt", "image", "video"]).optional(),
  qualityLevel: z.enum(["fast", "standard", "high", "strict"]).optional(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
  requiresAudit: z.boolean().optional(),
  requestedSkills: z.array(z.string()).optional(),
  source: z.string().optional(),
  sourceMeta: z.record(z.any()).optional(),
});

const taskActionParamsSchema = z.object({
  id: z.string().min(1),
});

const knowledgeQuerySchema = z.object({
  q: z.string().optional(),
  layer: z.enum(["working", "episodic", "long_term"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const knowledgeUpsertSchema = z.object({
  key: z.string().min(1).optional(),
  kind: z.enum(["task_history", "preference", "project_context", "fact", "manual_note"]).default("manual_note"),
  layer: z.enum(["working", "episodic", "long_term"]).default("long_term"),
  title: z.string().min(1),
  content: z.string().min(1),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  importance: z.coerce.number().int().min(1).max(100).optional(),
  pinned: z.boolean().optional(),
});

const approvalQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "resolved", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const approvalPolicySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["auto", "manual", "observe"]),
  priority: z.coerce.number().int().min(1).max(999).optional(),
  matchTaskTypes: z.array(z.enum(["SIMPLE", "COMPLEX", "CODING"])).optional(),
  matchIntents: z.array(z.enum(["qa", "office_discussion", "doc", "ppt", "image", "video", "coding"])).optional(),
  matchArtifactTypes: z.array(z.enum(["none", "doc", "ppt", "image", "video"])).optional(),
  matchRunners: z.array(z.enum(["codex", "gemini"])).optional(),
  matchKeywords: z.array(z.string()).optional(),
});

export async function buildApp(
  cwd = process.cwd(),
  options?: {
    extensions?: ServerExtension[];
  },
): Promise<FastifyInstance> {
  const services = await createServices(cwd, { startScheduler: false, extensions: options?.extensions });
  const { app, env, monitor, orchestrator, store, registry, feishuBot, scheduler, configHotReloader, prisma, taskController } = services;
  const diagnosticsBridge = new MonitorDiagnosticsBridge(
    app.server,
    monitor,
    env.feishu.webhookUrl ? new FeishuNotifier(env.feishu) : null,
    store,
    feishuBot,
  );
  diagnosticsBridge.attach();

  app.get("/health", async () => {
    return {
      ok: true,
      time: new Date().toISOString(),
    };
  });

  app.get("/providers", async () => {
    const providers = await registry.refreshHealth();
    return {
      providers,
    };
  });

  app.get("/monitor", async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "20");
    return orchestrator.getMonitorSnapshot(limit);
  });

  app.get("/monitor/events", async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "50");
    return {
      events: orchestrator.listMonitorEvents(limit),
    };
  });

  app.get("/monitor/dashboard", async (_request, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return buildMonitorDashboardHtml();
  });

  app.get("/console", async (_request, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return buildControlConsoleHtml();
  });

  app.get("/roles", async () => {
    return {
      roles: orchestrator.listRoles(),
    };
  });

  app.get("/skills", async () => {
    return {
      skills: orchestrator.listSkills(),
    };
  });

  app.get("/skill-packs", async () => {
    return {
      skillPacks: orchestrator.listSkillPacks(),
    };
  });

  app.get("/tasks", async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? "20");
    return {
      tasks: await store.listTasks(limit),
    };
  });

  app.get("/knowledge", async (request) => {
    const query = knowledgeQuerySchema.parse(request.query ?? {});
    const entries = query.q
      ? await store.searchKnowledge({
          query: query.q,
          limit: query.limit ?? 20,
          layers: query.layer ? [query.layer] : undefined,
        })
      : (await store.listKnowledge(query.limit ?? 20)).filter((entry) => !query.layer || entry.layer === query.layer);

    return {
      entries,
      query: query.q ?? null,
    };
  });

  app.post("/knowledge", async (request, reply) => {
    const body = knowledgeUpsertSchema.parse(request.body);
    const entry = await store.upsertKnowledge({
      key: body.key ?? `manual:${hashContent(`${body.kind}:${body.title}:${body.content}`)}`,
      kind: body.kind,
      layer: body.layer,
      title: body.title,
      content: body.content,
      summary: body.summary,
      tags: body.tags,
      importance: body.importance,
      pinned: body.pinned,
      source: "manual_api",
    });
    reply.code(201);
    return {
      ok: true,
      entry,
    };
  });

  app.get("/memory", async (request) => {
    const query = knowledgeQuerySchema.parse(request.query ?? {});
    const entries = query.q
      ? await store.searchKnowledge({
          query: query.q,
          limit: query.limit ?? 20,
          layers: query.layer ? [query.layer] : undefined,
        })
      : (await store.listKnowledge(query.limit ?? 20)).filter((entry) => !query.layer || entry.layer === query.layer);

    return {
      entries,
      layer: query.layer ?? null,
      query: query.q ?? null,
    };
  });

  app.post("/memory", async (request, reply) => {
    const body = knowledgeUpsertSchema.parse(request.body);
    const entry = await store.upsertKnowledge({
      key: body.key ?? `memory:${hashContent(`${body.layer}:${body.kind}:${body.title}:${body.content}`)}`,
      kind: body.kind,
      layer: body.layer,
      title: body.title,
      content: body.content,
      summary: body.summary,
      tags: body.tags,
      importance: body.importance,
      pinned: body.pinned,
      source: "memory_api",
    });
    reply.code(201);
    return {
      ok: true,
      entry,
    };
  });

  app.get("/approvals", async (request) => {
    const query = approvalQuerySchema.parse(request.query ?? {});
    return {
      approvals: await store.listApprovalRequests({
        status: query.status,
        limit: query.limit ?? 50,
      }),
    };
  });

  app.get("/approval-policies", async () => {
    return {
      policies: await store.listApprovalPolicies(),
    };
  });

  app.post("/approval-policies", async (request, reply) => {
    const body = approvalPolicySchema.parse(request.body);
    const policy = await store.upsertApprovalPolicy(body);
    reply.code(201);
    return {
      ok: true,
      policy,
    };
  });

  app.get("/tasks/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const task = await store.getTask(params.id);

    if (!task) {
      reply.code(404);
      return {
        error: "Task not found.",
      };
    }

    return {
      ...task,
      workflow: deriveWorkflowView(task),
    };
  });

  app.post("/tasks", async (request, reply) => {
    const body = submitTaskSchema.parse(request.body);
    const shouldNotifyFeishu = body.source !== "scheduler" && body.source !== "feishu";
    const submission = {
      ...body,
      sourceMeta: {
        ...(body.sourceMeta ?? {}),
        ...(shouldNotifyFeishu && (body.sourceMeta?.feishuNotify ?? true) ? { feishuNotify: true } : {}),
      },
    };
    const result = await orchestrator.submitTask(submission);
    reply.code(202);
    return {
      ...result,
      message: "Task accepted.",
    };
  });

  app.post("/tasks/:id/stop", async (request, reply) => {
    const { id } = taskActionParamsSchema.parse(request.params);
    const task = await taskController.stopTask(id);
    if (!task) {
      reply.code(404);
      return { error: "Task not found." };
    }
    await feishuBot.replyTaskFailure(task).catch(() => undefined);
    return {
      ok: true,
      task,
      message: task.status === "failed" ? "Task stopped." : "Task is already finalized.",
    };
  });

  app.post("/tasks/:id/intervene", async (request, reply) => {
    const { id } = taskActionParamsSchema.parse(request.params);
    const task = await taskController.interveneTask(id);
    if (!task) {
      reply.code(404);
      return { error: "Task not found." };
    }
    await feishuBot.replyTaskProgress(task).catch(() => undefined);
    return {
      ok: true,
      task,
      message: task.status === "needs_human_intervention" ? "Task moved to human intervention." : "Task is already finalized.",
    };
  });

  app.post("/tasks/:id/approve", async (request, reply) => {
    const { id } = taskActionParamsSchema.parse(request.params);
    const task = await taskController.approveTask(id);
    if (!task) {
      reply.code(404);
      return { error: "Task not found." };
    }
    await feishuBot.replyTaskProgress(task).catch(() => undefined);
    return {
      ok: true,
      task,
      message: "Task approval handled.",
    };
  });

  app.post("/tasks/:id/reject", async (request, reply) => {
    const { id } = taskActionParamsSchema.parse(request.params);
    const task = await taskController.rejectTask(id);
    if (!task) {
      reply.code(404);
      return { error: "Task not found." };
    }
    await feishuBot.replyTaskFailure(task).catch(() => undefined);
    return {
      ok: true,
      task,
      message: "Task rejected.",
    };
  });

  app.post("/feishu/webhook/push", async (request, reply) => {
    const body = z
      .object({
        text: z.string().min(1),
      })
      .parse(request.body);

    await feishuBot.pushWebhookTestMessage(body.text);
    reply.code(202);
    return {
      ok: true,
      message: "Webhook push attempted.",
    };
  });

  app.post("/feishu/events", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, any>;
    app.log.info(
      {
        feishuEventSummary: summarizeFeishuPayload(body),
      },
      "Received Feishu event",
    );
    const response = await feishuBot.handleEvent(body);
    app.log.info(
      {
        feishuEventResponse: response,
      },
      "Handled Feishu event",
    );
    reply.code(200);
    return response;
  });

  app.get("/feishu/events", async () => {
    return {
      ok: true,
      message: "Feishu callback endpoint is reachable. Use POST for event delivery.",
    };
  });

  app.setNotFoundHandler(async (_request, reply) => {
    reply.code(404);
    return {
      error: "Not found",
    };
  });

  app.addHook("onListen", async () => {
    scheduler?.start();
  });

  app.addHook("onClose", async () => {
    diagnosticsBridge.close();
    scheduler?.stop();
    configHotReloader?.close();
    feishuBot.close();
    await registry.closeAll();
    await prisma.$disconnect();
  });

  app.post("/copilot/bridge", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
    const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
    const context = typeof body.context === "string" ? body.context : undefined;
    const mode = typeof body.mode === "string" && ["review", "generate", "edit"].includes(body.mode) ? body.mode : "generate";

    if (!prompt) {
      return reply.status(400).send({ error: "prompt is required" });
    }

    return {
      status: "bridge_ready",
      taskId: taskId ?? null,
      mode,
      message: "Copilot bridge endpoint active. Connect a VS Code extension to send requests.",
      prompt: prompt.slice(0, 200),
      context: context ? context.slice(0, 200) : null,
    };
  });

  app.get("/", async () => {
    return {
      service: "larkdesk-local-agent",
      routes: [
        "GET /health",
        "GET /providers",
        "GET /monitor",
        "GET /monitor/events",
        "GET /monitor/dashboard",
        "GET /console",
        "GET /roles",
        "GET /skills",
        "GET /skill-packs",
        "GET /tasks",
        "GET /tasks/:id",
        "GET /knowledge",
        "POST /knowledge",
        "GET /memory",
        "POST /memory",
        "GET /approvals",
        "GET /approval-policies",
        "POST /approval-policies",
        "POST /tasks",
        "POST /tasks/:id/stop",
        "POST /tasks/:id/intervene",
        "POST /tasks/:id/approve",
        "POST /tasks/:id/reject",
        "POST /feishu/events",
        "POST /feishu/webhook/push",
        "POST /copilot/bridge",
      ],
      demo: summarizeText("Use POST /tasks with { input: '你好' } to run the mock provider flow.", 120),
    };
  });

  for (const extension of services.extensions) {
    await extension.registerRoutes?.(app, services);
  }

  return app;
}

function deriveWorkflowView(task: Record<string, any>): Record<string, unknown> {
  const sourceMeta = (task.sourceMeta ?? {}) as Record<string, any>;
  const workflow = (sourceMeta.workflow ?? {}) as Record<string, any>;
  const result = (task.result ?? {}) as Record<string, any>;
  const localContext = (result.localContext ?? {}) as Record<string, any>;

  return {
    intent: workflow.intent ?? null,
    budget: workflow.budget ?? null,
    artifactType: workflow.artifactType ?? null,
    qualityLevel: workflow.qualityLevel ?? null,
    riskLevel: workflow.riskLevel ?? null,
    complexityScore: workflow.complexityScore ?? null,
    audit: workflow.audit ?? null,
    selectedSkills: workflow.selectedSkills ?? [],
    selectedSkillPacks: workflow.selectedSkillPacks ?? [],
    approvalPlan: workflow.approvalPlan ?? null,
    rolePlan: workflow.rolePlan ?? null,
    localAccessBackend: localContext.backend ?? null,
    localAccessPaths: localContext.referencedPaths ?? [],
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    artifactSummary: typeof result.artifactSummary === "string" ? result.artifactSummary : null,
  };
}

function summarizeFeishuPayload(body: Record<string, any>): Record<string, unknown> {
  const event = body?.event;
  const message = event?.message;

  return {
    type: body?.type ?? null,
    hasEncrypt: typeof body?.encrypt === "string",
    schema: body?.schema ?? null,
    tokenPresent: typeof body?.token === "string",
    headerEventType: body?.header?.event_type ?? null,
    headerTokenPresent: typeof body?.header?.token === "string",
    appIdPresent: typeof body?.header?.app_id === "string",
    messageIdPresent: typeof message?.message_id === "string",
    chatIdPresent: typeof message?.chat_id === "string",
    contentPresent: typeof message?.content === "string",
  };
}
