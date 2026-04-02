import type {
  ArtifactExecutor,
  CodexRunner,
  ExecutionResult,
  LocalAccessService,
  TaskNotifier,
  TaskStore,
} from "./contracts";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  classifyTask,
  hasRealtimeInfoNeed,
  inferArtifactType,
  inferAuditPolicy,
  inferTaskComplexity,
  inferComplexityScore,
  inferTaskBudget,
  inferTaskIntent,
  inferTaskQualityLevel,
  inferTaskRiskLevel,
  inferTier,
} from "./classifier";
import { AuditEngine } from "./audit-engine";
import { MonitorHub } from "./monitor";
import { PolicyEngine } from "./policy-engine";
import { ProviderRegistry } from "./provider-registry";
import { RoleRegistry } from "./role-registry";
import { RouterV2 } from "./router-v2";
import { SkillRegistry } from "./skill-registry";
import type {
  ApprovalPolicyRecord,
  AuditResult,
  CodingHandoffBundle,
  KnowledgeEntryRecord,
  MonitorDashboardReport,
  MonitorEvent,
  PromptCatalog,
  RoutingPolicy,
  TaskBudget,
  TaskIntent,
  ProviderExecutionTarget,
  TaskRoleAssignment,
  TaskRecord,
  TaskStatus,
  TaskSubmission,
  TaskApprovalPlan,
  TaskType,
  WorkflowMeta,
  WorkflowRoutePlan,
} from "./types";
import { hashContent, normalizeWhitespace, renderTemplate, summarizeText } from "./utils";

export class TaskOrchestrator {
  private readonly artifactExecutors = new Map<string, ArtifactExecutor>();
  private readonly roleRegistry: RoleRegistry;
  private readonly skillRegistry: SkillRegistry;
  private readonly auditEngine: AuditEngine;
  private readonly monitor: MonitorHub;
  private readonly policyEngine: PolicyEngine;

  constructor(
    private readonly store: TaskStore,
    private readonly providers: ProviderRegistry,
    private readonly routingPolicy: RoutingPolicy,
    private readonly prompts: PromptCatalog,
    private readonly notifier: TaskNotifier,
    private readonly codexRunner: CodexRunner,
    private readonly localAccess: LocalAccessService,
    artifactExecutors: ArtifactExecutor[],
    options?: {
      roleRegistry?: RoleRegistry;
      skillRegistry?: SkillRegistry;
      auditEngine?: AuditEngine;
      monitor?: MonitorHub;
    },
  ) {
    for (const executor of artifactExecutors) {
      this.artifactExecutors.set(executor.kind, executor);
    }
    this.roleRegistry = options?.roleRegistry ?? new RoleRegistry();
    this.skillRegistry = options?.skillRegistry ?? new SkillRegistry();
    this.auditEngine = options?.auditEngine ?? new AuditEngine();
    this.monitor = options?.monitor ?? new MonitorHub();
    this.policyEngine = new PolicyEngine(this.routingPolicy, this.providers.list());
  }

  async submitTask(submission: TaskSubmission): Promise<{ taskId: string; taskType: TaskType }> {
    const taskType = classifyTask(submission);
    const workflow: WorkflowMeta = {
      tier: inferTier(submission),
      intent: inferTaskIntent(submission),
      budget: inferTaskBudget(submission),
      artifactType: inferArtifactType(submission),
      qualityLevel: inferTaskQualityLevel(submission),
      riskLevel: inferTaskRiskLevel(submission),
      complexity: inferTaskComplexity(submission),
      complexityScore: inferComplexityScore(submission),
      audit: inferAuditPolicy(submission),
      selectedSkills: [],
      presetHints: submission.presetHints,
      executionPolicy: submission.executionPolicy,
    };
    workflow.selectedSkills = this.skillRegistry.resolveForTask({
      submission,
      taskType,
      workflow,
    });
    workflow.selectedSkillPacks = this.skillRegistry.resolvePacksForSelection(workflow.selectedSkills);
    workflow.approvalPlan = await this.buildApprovalPlan(submission, taskType, workflow);
    const normalizedInput = summarizeText(submission.input, 4_000);
    const cacheKey = hashContent(`${taskType}:${workflow.intent}:${normalizedInput}`);

    const task = await this.store.createTask({
      type: taskType,
      status: "queued",
      source: submission.source ?? "api",
      sourceMeta: {
        ...(submission.sourceMeta ?? {}),
        workflow,
      },
      userInput: submission.input,
      normalizedInput,
      summary: summarizeText(submission.input, 160),
      cacheKey,
    });

    this.monitor.recordTask(task, workflow);
    this.monitor.emit({
      type: "task.accepted",
      taskId: task.id,
      status: task.status,
      detail: task.summary ?? task.normalizedInput,
      meta: {
        workflow,
      },
    });
    this.monitor.emit({
      type: "task.skills_selected",
      taskId: task.id,
      status: task.status,
      detail: workflow.selectedSkills.map((skill) => skill.id).join(", "),
      meta: {
        skills: workflow.selectedSkills,
      },
    });

    await this.notifier.notifyTaskAccepted(task);

    void this.executeTask(task.id).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const failedTask = await this.store.failTask(task.id, message, resolveFailureStatus([message]));
      this.monitor.recordTask(failedTask, workflow);
      this.monitor.emit({
        type: "task.failed",
        taskId: failedTask.id,
        status: failedTask.status,
        detail: failedTask.error ?? message,
      });
      await this.notifier.notifyTaskFailed(failedTask);
    });

    return {
      taskId: task.id,
      taskType,
    };
  }

  async executeTask(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const initialWorkflow = extractWorkflowMeta(task);
    this.monitor.recordTask(task, initialWorkflow);

    if (task.type === "SIMPLE") {
      const shortcutAnswer = resolveLocalSimpleShortcut(task.userInput);
      if (shortcutAnswer) {
        const completed = await this.store.completeTask(taskId, summarizeText(shortcutAnswer, 240), {
          answer: shortcutAnswer,
          provider: "local_fastlane",
          cached: false,
        });
        await this.persistKnowledgeFromTask(completed);
        this.monitor.recordTask(completed, initialWorkflow);
        this.monitor.emit({
          type: "task.completed",
          taskId: completed.id,
          status: completed.status,
          detail: completed.outputSummary ?? shortcutAnswer,
          meta: {
            provider: "local_fastlane",
          },
        });
        await this.notifier.notifyTaskCompleted(completed);
        return completed;
      }
    }

    const allowCache = task.type !== "SIMPLE";
    const cached = allowCache && task.cacheKey ? await this.store.getCache(task.cacheKey) : null;
    if (cached && !isPromptTemplateEcho(typeof cached.answer === "string" ? cached.answer : "", task)) {
      const completed = await this.store.completeTask(taskId, summarizeText(String(cached.answer ?? ""), 240), cached);
      await this.persistKnowledgeFromTask(completed);
      this.monitor.recordTask(completed, initialWorkflow);
      this.monitor.emit({
        type: "task.cache_hit",
        taskId: completed.id,
        status: completed.status,
        detail: completed.outputSummary ?? "cache_hit",
      });
      this.monitor.emit({
        type: "task.completed",
        taskId: completed.id,
        status: completed.status,
        detail: completed.outputSummary ?? "cache_hit",
      });
      await this.notifier.notifyTaskCompleted(completed);
      return completed;
    }

    let taskState = await this.transitionTask(taskId, "classifying", task, initialWorkflow, "任务分类中");

    const workflow = extractWorkflowMeta(taskState);
    taskState = await this.transitionTask(taskId, "routing", taskState, workflow, "角色链路规划中");
    const baseRoute = this.applyRouteOverrides(
      taskState,
      new RouterV2(this.routingPolicy, this.providers.list()).route(task.type, workflow),
    );
    const route = this.policyEngine.decorateRoutePlan(task.type, workflow, baseRoute);
    const decoratedWorkflow = this.auditEngine.decorateAuditPolicy(
      {
        ...workflow,
        modelPlan: this.policyEngine.buildModelPlan(route),
        rolePlan: this.roleRegistry.buildPlan(task.type, workflow, route),
      },
      route.auditTarget?.provider ?? workflow.audit.provider ?? route.finalArbiter ?? route.reviewers[0] ?? route.draftProvider,
    );
    taskState = await this.persistWorkflow(taskId, taskState, decoratedWorkflow);
    this.monitor.emit({
      type: "task.route_selected",
      taskId,
      status: taskState.status,
      detail: route.kind,
      meta: {
        route,
        rolePlan: decoratedWorkflow.rolePlan,
        modelPlan: decoratedWorkflow.modelPlan,
      },
    });
    taskState = await this.transitionTask(taskId, "skill_planning", taskState, decoratedWorkflow, "技能装配完成");

    if (route.kind === "simple") {
      return this.executeSimple(taskState, decoratedWorkflow, route);
    }

    if (route.kind === "doc" || route.kind === "ppt" || route.kind === "image" || route.kind === "video") {
      return this.executeArtifactWorkflow(taskState, decoratedWorkflow, route);
    }

    if (route.kind === "coding") {
      return this.executeCoding(taskState, decoratedWorkflow, route);
    }

    return this.executeOffice(taskState, decoratedWorkflow, route);
  }

  async getExecutionResult(taskId: string): Promise<ExecutionResult | null> {
    const task = await this.store.getTask(taskId);
    if (!task) {
      return null;
    }

    return {
      task,
      cached: Boolean(task.result?.cached),
    };
  }

  private async executeSimple(task: TaskRecord, workflow: WorkflowMeta, route: WorkflowRoutePlan): Promise<TaskRecord> {
    const shortcutAnswer = resolveLocalSimpleShortcut(task.userInput);
    if (shortcutAnswer) {
      const completed = await this.store.completeTask(task.id, summarizeText(shortcutAnswer, 240), {
        answer: shortcutAnswer,
        provider: "local_fastlane",
        cached: false,
      });
      await this.persistKnowledgeFromTask(completed);
      this.monitor.recordTask(completed, workflow);
      this.monitor.emit({
        type: "task.completed",
        taskId: completed.id,
        status: completed.status,
        detail: completed.outputSummary ?? shortcutAnswer,
        meta: {
          provider: "local_fastlane",
        },
      });
      await this.notifier.notifyTaskCompleted(completed);
      return completed;
    }

    const providerTargets = uniqueExecutionTargets([route.draftTarget, ...(route.fallbackTargets ?? [])]);
    const sharedContext = await this.loadLocalContext(task, workflow, false);
    const failures: string[] = [];
    for (const target of providerTargets) {
      try {
        const prompt = this.composePrompt(this.buildDraftPrompt(target.provider, task), task, sharedContext);
        const result = await this.runProviderPhase(task, target, "drafting", prompt);
        const audited = await this.runAuditLoop(task, workflow, route, {
          answer: result.outputText,
          provider: result.provider,
          providerTarget: result.target,
          reviewOutputs: [],
          failures,
          localContext: sharedContext,
          providerMeta: result.meta,
        });
        if (audited.status === "needs_human_intervention") {
          await this.notifier.notifyTaskFailed(audited.task);
          return audited.task;
        }
        const completed = await this.store.completeTask(task.id, summarizeText(audited.answer, 240), {
          answer: audited.answer,
          provider: audited.provider,
          providerMeta: audited.providerMeta,
          cached: false,
          audit: audited.audit,
        });
        await this.persistKnowledgeFromTask(completed);

        this.monitor.recordTask(completed, workflow);
        this.monitor.emit({
          type: "task.completed",
          taskId: completed.id,
          status: completed.status,
          detail: completed.outputSummary ?? result.summary,
          provider: completed.result?.provider as string | undefined,
        });
        await this.notifier.notifyTaskCompleted(completed);
        return completed;
      } catch (error) {
        failures.push(`${target.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const failed = await this.store.failTask(task.id, failures.join(" | "), resolveFailureStatus(failures));
    this.monitor.recordTask(failed, workflow);
    this.monitor.emit({
      type: "task.failed",
      taskId: failed.id,
      status: failed.status,
      detail: failed.error ?? "simple_failed",
    });
    await this.notifier.notifyTaskFailed(failed);
    return failed;
  }

  private async executeOffice(
    task: TaskRecord,
    workflow: WorkflowMeta,
    route: WorkflowRoutePlan,
    notifyOnCompletion = true,
  ): Promise<TaskRecord> {
    const continuation = extractContinuation(task);
    const localContext =
      continuation?.localContextSummary
        ? {
            summary: continuation.localContextSummary,
            backend: "continued_task" as const,
          }
        : await this.loadLocalContext(task, workflow, route.useLocalAccess);

    if (continuation?.restartPhase === "audit_pending" && continuation.previousAnswer) {
      const seededDraftOutput = continuation.previousDraftOutput
        ? {
            provider: continuation.previousDraftOutput.provider,
            text: continuation.previousDraftOutput.text,
            summary: continuation.previousDraftOutput.summary ?? summarizeText(continuation.previousDraftOutput.text, 240),
            meta: continuation.previousDraftOutput.meta,
            target: route.draftTarget ?? route.finalArbiterTarget ?? this.normalizeExecutionTarget(route.draftProvider, "drafting", task),
          }
        : null;
      const seededReviewOutputs = continuation.previousReviewOutputs ?? [];
      const audited = await this.runAuditLoop(task, workflow, route, {
        answer: continuation.previousAnswer,
        provider: continuation.previousProvider ?? seededDraftOutput?.provider ?? route.finalArbiterTarget?.provider ?? route.draftProvider,
        providerTarget: route.finalArbiterTarget ?? seededDraftOutput?.target ?? route.draftTarget,
        providerMeta: continuation.previousProviderMeta,
        reviewOutputs: seededReviewOutputs,
        failures: continuation.previousFailures ? [...continuation.previousFailures] : [],
        localContext,
        draftOutput: seededDraftOutput,
      });

      if (audited.status === "needs_human_intervention") {
        if (notifyOnCompletion) {
          await this.notifier.notifyTaskFailed(audited.task);
        }
        return audited.task;
      }

      const completed = await this.store.completeTask(task.id, summarizeText(audited.answer, 240), {
        answer: audited.answer,
        provider: audited.provider,
        providerMeta: audited.providerMeta,
        draftOutput: seededDraftOutput,
        reviewOutputs: seededReviewOutputs,
        failures: continuation.previousFailures ?? [],
        localContext,
        resumedFrom: continuation.fromTaskId,
        resumedPhase: continuation.restartPhase,
        degraded: Array.isArray(continuation.previousFailures) && continuation.previousFailures.length > 0,
        audit: audited.audit,
      });
      await this.persistKnowledgeFromTask(completed);
      this.monitor.recordTask(completed, workflow);
      if (notifyOnCompletion) {
        this.monitor.emit({
          type: "task.completed",
          taskId: completed.id,
          status: completed.status,
          detail: completed.outputSummary ?? audited.answer,
          provider: audited.provider,
          meta: {
            resumedFrom: continuation.fromTaskId,
            resumedPhase: continuation.restartPhase,
          },
        });
        await this.notifier.notifyTaskCompleted(completed);
      }
      return completed;
    }

    const failures: string[] = [];
    let draftOutput: { provider: string; text: string; summary: string; meta?: Record<string, unknown>; target: ProviderExecutionTarget } | null = null;
    for (const draftTarget of uniqueExecutionTargets([route.draftTarget, ...(route.fallbackTargets ?? [])])) {
      try {
        const draftPrompt = this.composePrompt(
          this.buildDraftPrompt(draftTarget.provider, task),
          task,
          localContext,
        );
        const result = await this.runProviderPhase(task, draftTarget, "drafting", draftPrompt);
        draftOutput = {
          provider: result.provider,
          text: result.outputText,
          summary: result.summary,
          meta: result.meta,
          target: result.target,
        };
        break;
      } catch (error) {
        failures.push(`${draftTarget.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!draftOutput) {
      const failed = await this.store.failTask(task.id, failures.join(" | "), resolveFailureStatus(failures));
      this.monitor.recordTask(failed, workflow);
      this.monitor.emit({
        type: "task.failed",
        taskId: failed.id,
        status: failed.status,
        detail: failed.error ?? "office_failed",
      });
      await this.notifier.notifyTaskFailed(failed);
      return failed;
    }

    const reviewOutputs: Array<{ provider: string; text: string; meta?: Record<string, unknown>; target?: ProviderExecutionTarget }> = [];
    for (const reviewer of route.reviewerTargets ?? []) {
      try {
        const prompt = this.composePrompt(
          this.buildReviewPrompt(reviewer.provider, task, draftOutput.provider, draftOutput.text),
          task,
          localContext,
        );
        const result = await this.runProviderPhase(task, reviewer, "reviewing", prompt);
        reviewOutputs.push({ provider: result.provider, text: result.outputText, meta: result.meta, target: result.target });
      } catch (error) {
        failures.push(`${reviewer.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let finalAnswer = draftOutput.text;
    let finalProvider = draftOutput.provider;
    let finalProviderMeta = draftOutput.meta;
    if (route.finalArbiterTarget) {
      try {
        const arbitrationPrompt = this.composePrompt(
          this.buildArbitrationPrompt(task, route.finalArbiterTarget.provider, draftOutput.provider, draftOutput.text, reviewOutputs),
          task,
          localContext,
        );
        const arbiter = await this.runProviderPhase(task, route.finalArbiterTarget, "arbitrating", arbitrationPrompt);
        finalAnswer = arbiter.outputText;
        finalProvider = arbiter.provider;
        finalProviderMeta = arbiter.meta;
      } catch (error) {
        failures.push(`${route.finalArbiterTarget.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const audited = await this.runAuditLoop(task, workflow, route, {
      answer: finalAnswer,
      provider: finalProvider,
      providerTarget: route.finalArbiterTarget ?? draftOutput.target,
      providerMeta: finalProviderMeta,
      reviewOutputs,
      failures,
      localContext,
      draftOutput,
    });
    if (audited.status === "needs_human_intervention") {
      if (notifyOnCompletion) {
        await this.notifier.notifyTaskFailed(audited.task);
      }
      return audited.task;
    }

    const completed = await this.store.completeTask(task.id, summarizeText(audited.answer, 240), {
      answer: audited.answer,
      provider: audited.provider,
      providerMeta: audited.providerMeta,
      draftOutput,
      reviewOutputs,
      failures,
      localContext,
      degraded: failures.length > 0,
      manualLoginRequired: failures.some((entry) => classifyFailureStatus(entry) === "needs_manual_login"),
      audit: audited.audit,
    });
    await this.persistKnowledgeFromTask(completed);
    this.monitor.recordTask(completed, workflow);
    if (notifyOnCompletion) {
      this.monitor.emit({
        type: "task.completed",
        taskId: completed.id,
        status: completed.status,
        detail: completed.outputSummary ?? audited.answer,
        provider: audited.provider,
      });
    }
    if (notifyOnCompletion) {
      await this.notifier.notifyTaskCompleted(completed);
    }
    return completed;
  }

  private async executeArtifactWorkflow(task: TaskRecord, workflow: WorkflowMeta, route: WorkflowRoutePlan): Promise<TaskRecord> {
    const officeResult = await this.executeOffice(task, workflow, route, false);
    if (officeResult.status !== "completed") {
      return officeResult;
    }

    const executor = route.executor ? this.artifactExecutors.get(route.executor) : null;
    if (!executor) {
      return officeResult;
    }

    const draftOutput = getNestedText(officeResult.result, "draftOutput", "text");
    const reviewOutput = getFirstReviewText(officeResult.result);
    const answer = typeof officeResult.result?.answer === "string" ? officeResult.result.answer : officeResult.outputSummary ?? "";
    const localContextSummary = getLocalContextSummary(officeResult.result);

    const execution = await executor.execute({
      taskId: task.id,
      intent:
        route.kind === "doc"
          ? "doc"
          : route.kind === "ppt"
            ? "ppt"
            : route.kind === "image"
              ? "image"
              : "video",
      userInput: task.userInput,
      finalOutput: answer,
      draftOutput: draftOutput ?? answer,
      reviewOutput: reviewOutput ?? undefined,
      localContextSummary: localContextSummary ?? undefined,
      providerName: typeof officeResult.result?.provider === "string" ? officeResult.result.provider : undefined,
      providerMeta:
        officeResult.result?.providerMeta && typeof officeResult.result.providerMeta === "object"
          ? (officeResult.result.providerMeta as Record<string, unknown>)
          : undefined,
    });

    const updated = await this.store.updateTask(task.id, {
      result: {
        ...(officeResult.result ?? {}),
        artifacts: execution.artifacts,
        artifactSummary: execution.summary,
        executor: execution.executor,
      },
      outputSummary: summarizeText(`${answer}\n\n${execution.summary}`, 240),
    });
    await this.persistKnowledgeFromTask(updated);
    this.monitor.recordTask(updated, workflow);
    this.monitor.emit({
      type: "task.completed",
      taskId: updated.id,
      status: updated.status,
      detail: updated.outputSummary ?? execution.summary,
    });
    await this.notifier.notifyTaskCompleted(updated);
    return updated;
  }

  private async executeCoding(task: TaskRecord, workflow: WorkflowMeta, route: WorkflowRoutePlan): Promise<TaskRecord> {
    const localContext = await this.loadLocalContext(task, workflow, true);
    if (shouldDirectToCodex(task)) {
      return this.executeDirectCodexHandoff(task, workflow, route, localContext);
    }

    const draftTarget = route.draftTarget ?? this.policyEngine.resolveTarget("zhongshu_drafter", route.draftProvider, task.type, workflow);
    const draftPrompt = this.composePrompt(
      this.buildDraftPrompt(draftTarget.provider, task),
      task,
      localContext,
    );

    const failures: string[] = [];
    let draftOutput: { provider: string; text: string; summary: string; target: ProviderExecutionTarget } | null = null;
    try {
      const result = await this.runProviderPhase(task, draftTarget, "drafting", draftPrompt);
      draftOutput = {
        provider: result.provider,
        text: result.outputText,
        summary: result.summary,
        target: result.target,
      };
    } catch (error) {
      failures.push(`${route.draftTarget?.provider ?? route.draftProvider}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!draftOutput) {
      const failed = await this.store.failTask(task.id, failures.join(" | "), resolveFailureStatus(failures));
      this.monitor.recordTask(failed, workflow);
      this.monitor.emit({
        type: "task.failed",
        taskId: failed.id,
        status: failed.status,
        detail: failed.error ?? "coding_failed",
      });
      await this.notifier.notifyTaskFailed(failed);
      return failed;
    }

    const reviewOutputs: Array<{ provider: string; text: string; target?: ProviderExecutionTarget }> = [];
    for (const reviewer of route.reviewerTargets ?? []) {
      try {
        const prompt = this.composePrompt(
          this.buildReviewPrompt(reviewer.provider, task, draftOutput.provider, draftOutput.text),
          task,
          localContext,
        );
        const result = await this.runProviderPhase(task, reviewer, "reviewing", prompt);
        reviewOutputs.push({ provider: result.provider, text: result.outputText, target: result.target });
      } catch (error) {
        failures.push(`${reviewer.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let finalPlan = draftOutput.text;
    if (route.finalArbiterTarget) {
      try {
        const arbitrationPrompt = this.composePrompt(
          this.buildCodingArbitrationPrompt(task, route.finalArbiterTarget.provider, draftOutput.provider, draftOutput.text, reviewOutputs),
          task,
          localContext,
        );
        const arbiter = await this.runProviderPhase(task, route.finalArbiterTarget, "arbitrating", arbitrationPrompt);
        finalPlan = arbiter.outputText;
      } catch (error) {
        failures.push(`${route.finalArbiterTarget.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const audited = await this.runAuditLoop(task, workflow, route, {
      answer: finalPlan,
      provider: route.finalArbiterTarget?.provider ?? draftOutput.provider,
      providerTarget: route.finalArbiterTarget ?? draftOutput.target,
      reviewOutputs,
      failures,
      localContext,
      draftOutput,
    });
    if (audited.status === "needs_human_intervention") {
      await this.notifier.notifyTaskFailed(audited.task);
      return audited.task;
    }

    await this.transitionTask(task.id, "handoff_to_codex", task, workflow, "进入 Codex 交接");
    const candidatePlans = buildCodingCandidatePlans(
      draftOutput,
      reviewOutputs,
      route.finalArbiterTarget?.provider,
      audited.answer,
    );
    const bundle = buildCodingBundle(task, candidatePlans, audited.answer);
    const artifacts = await this.codexRunner.createArtifacts(bundle);

    const available = await this.codexRunner.isAvailable();
    let codexExecution: Record<string, unknown> | null = null;
    if (available && route.autoRunCodex && this.codexRunner.run) {
      await this.transitionTask(task.id, "implementing", task, workflow, "执行实现阶段");
      codexExecution = await this.codexRunner.run(bundle, artifacts);
    }

    await this.transitionTask(task.id, "testing", task, workflow, "执行测试阶段");
    const generatedArtifacts = await collectDeliverableArtifacts(
      artifacts.taskDir,
      [
        typeof codexExecution?.stdout === "string" ? codexExecution.stdout : undefined,
        typeof codexExecution?.stderr === "string" ? codexExecution.stderr : undefined,
      ],
    );
    const completed = await this.store.completeTask(task.id, summarizeText(audited.answer, 240), {
      candidatePlans,
      reviewOutputs,
      finalPlan: audited.answer,
      failures,
      localContext,
      artifacts: generatedArtifacts,
      codexArtifacts: artifacts,
      codexExecution,
      degraded: failures.length > 0,
      manualLoginRequired: failures.some((entry) => classifyFailureStatus(entry) === "needs_manual_login"),
      audit: audited.audit,
    });
    await this.persistKnowledgeFromTask(completed);
    this.monitor.recordTask(completed, workflow);
    this.monitor.emit({
      type: "task.completed",
      taskId: completed.id,
      status: completed.status,
      detail: completed.outputSummary ?? audited.answer,
      provider: audited.provider,
    });
    await this.notifier.notifyTaskCompleted(completed);
    return completed;
  }

  private async executeDirectCodexHandoff(
    task: TaskRecord,
    workflow: WorkflowMeta,
    route: WorkflowRoutePlan,
    localContext: { summary: string; backend: string } | null,
  ): Promise<TaskRecord> {
    const directCliRunner = getDirectCliRunner(task);
    const runnerLabel = getDirectCliRunnerLabel(directCliRunner);

    await this.transitionTask(task.id, "handoff_to_codex", task, workflow, `直接交给 ${runnerLabel} 执行`);
    const bundle = buildDirectCodexBundle(task, localContext);
    const artifacts = await this.codexRunner.createArtifacts(bundle);

    const available = await this.codexRunner.isAvailable();
    let codexExecution: { stdout: string; stderr: string; success: boolean; sessionId?: string } | null = null;
    const failures: string[] = [];

    if (route.autoRunCodex) {
      if (available && this.codexRunner.run) {
        await this.transitionTask(task.id, "implementing", task, workflow, `执行 ${runnerLabel} 直通任务`);
        codexExecution = await this.codexRunner.run(bundle, artifacts);
        if (!codexExecution.success) {
          failures.push(`codex_runner: ${summarizeText(codexExecution.stderr || codexExecution.stdout || "execution failed", 600)}`);
        }
      } else {
        failures.push(`codex_runner: ${runnerLabel} is not available in the current environment.`);
      }
    }

    const latestAfterRun = await this.store.getTask(task.id);
    if (latestAfterRun && isImmutableTerminalTaskStatus(latestAfterRun.status)) {
      return latestAfterRun;
    }

    await this.transitionTask(task.id, "testing", task, workflow, `收集 ${runnerLabel} 执行结果`);
    const authorizationResumePrompt = buildAuthorizationResumePrompt(task);
    const authorizationRaw =
      codexExecution && directCliRunner === "codex"
        ? [codexExecution.stderr, codexExecution.stdout].filter(Boolean).join("\n")
        : "";
    const authorizationMessage =
      directCliRunner === "codex"
        ? detectCliAuthorizationMessage(runnerLabel, authorizationRaw)
          ?? detectPermissionLimitedWriteCompletion(task.userInput, authorizationRaw)
        : null;
    const outputSummary = summarizeDirectCliExecution(runnerLabel, codexExecution, route.autoRunCodex);

    const generatedArtifacts = await collectDeliverableArtifacts(
      artifacts.taskDir,
      [codexExecution?.stdout, codexExecution?.stderr],
    );
    if (authorizationMessage || shouldPauseForPermissionLimitedWrite(task.userInput, authorizationRaw, generatedArtifacts.length)) {
      const detail = authorizationMessage ?? "Codex 当前只完成了只读分析，尚未真正写入文件；请在飞书中批准后继续执行。";
      const existingApproval = await this.store.findPendingApprovalRequestByTask(task.id).catch(() => null);
      if (!existingApproval) {
        await this.store.createApprovalRequest({
          taskId: task.id,
          policyKey: "cli_authorization",
          kind: "cli_authorization",
          summary: summarizeText(detail, 140),
          detail,
          runner: "codex",
          source: task.source,
        }).catch(() => null);
      }
      const paused = await this.store.updateTask(task.id, {
        status: "needs_human_intervention",
        error: detail,
        result: {
          candidatePlans: bundle.candidatePlans,
          reviewOutputs: [],
          finalPlan: bundle.finalPlan,
          failures,
          localContext,
          artifacts,
          codexExecution,
          degraded: true,
          manualLoginRequired: false,
          answer: detail,
          provider: directCliRunner === "gemini" ? "gemini_cli_runner" : "codex_runner",
          authorizationPending: true,
          authorizationRunner: "codex",
          authorizationSessionId: codexExecution?.sessionId,
          authorizationResumePrompt,
        },
      });
      this.monitor.recordTask(paused, workflow);
      this.monitor.emit({
        type: "task.failed",
        taskId: paused.id,
        status: paused.status,
        detail: paused.error ?? detail,
        provider: directCliRunner === "gemini" ? "gemini_cli_runner" : "codex_runner",
      });
      await this.notifier.notifyTaskFailed(paused);
      return paused;
    }
    const latestBeforeFinalize = await this.store.getTask(task.id);
    if (latestBeforeFinalize && isImmutableTerminalTaskStatus(latestBeforeFinalize.status)) {
      return latestBeforeFinalize;
    }
    if (route.autoRunCodex && codexExecution && !codexExecution.success && generatedArtifacts.length === 0) {
      const failed = await this.store.failTask(
        task.id,
        summarizeText(codexExecution.stderr || codexExecution.stdout || `${runnerLabel} execution failed.`, 240),
      );
      this.monitor.recordTask(failed, workflow);
      this.monitor.emit({
        type: "task.failed",
        taskId: failed.id,
        status: failed.status,
        detail: failed.error ?? `${runnerLabel} execution failed.`,
        provider: directCliRunner === "gemini" ? "gemini_cli_runner" : "codex_runner",
      });
      await this.notifier.notifyTaskFailed(failed);
      return failed;
    }
    const completed = await this.store.completeTask(task.id, summarizeText(outputSummary, 240), {
      candidatePlans: bundle.candidatePlans,
      reviewOutputs: [],
      finalPlan: bundle.finalPlan,
      failures,
      localContext,
      artifacts: generatedArtifacts,
      codexArtifacts: artifacts,
      codexExecution,
      degraded: failures.length > 0,
      manualLoginRequired: false,
      answer: outputSummary,
      provider: directCliRunner === "gemini" ? "gemini_cli_runner" : "codex_runner",
    });
    await this.persistKnowledgeFromTask(completed);
    this.monitor.recordTask(completed, workflow);
    this.monitor.emit({
      type: "task.completed",
      taskId: completed.id,
      status: completed.status,
      detail: completed.outputSummary ?? outputSummary,
      provider: directCliRunner === "gemini" ? "gemini_cli_runner" : "codex_runner",
    });
    await this.notifier.notifyTaskCompleted(completed);
    return completed;
  }

  private async runProviderPhase(
    task: TaskRecord,
    providerRef: string | ProviderExecutionTarget,
    phaseStatus: TaskStatus,
    prompt: string,
  ): Promise<{
    provider: string;
    target: ProviderExecutionTarget;
    outputText: string;
    summary: string;
    meta?: Record<string, unknown>;
  }> {
    const target = this.normalizeExecutionTarget(providerRef, phaseStatus, task);
    const providerName = target.provider;
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} is not registered.`);
    }

    const workflow = extractWorkflowMeta(task);
    await this.transitionTask(task.id, phaseStatus, task, workflow, `${providerName} 执行 ${phaseStatus}`);
    const stepId = await this.store.addTaskStep({
      taskId: task.id,
      phase: phaseStatus,
      provider: provider.name,
      status: "started",
      inputSummary: summarizeText(prompt, 400),
      meta: {
        preset: target.preset,
        timeoutMs: target.timeoutMs,
      },
    });
    this.monitor.heartbeat(resolveRoleForPhase(phaseStatus), {
      provider: provider.name,
      state: "running",
      detail: phaseStatus,
    });
    this.monitor.emit({
      type: "provider.started",
      taskId: task.id,
      provider: provider.name,
      role: resolveRoleForPhase(phaseStatus),
      status: phaseStatus,
      detail: summarizeText(prompt, 140),
      meta: {
        preset: target.preset,
        timeoutMs: target.timeoutMs,
      },
    });

    try {
      const session = await provider.ensureSession();
      if (!session.ok) {
        const needsManualLogin = Boolean(session.requiresManualLogin);
        await this.store.finishTaskStep(stepId, {
          status: "failed",
          outputSummary: summarizeText(session.detail, 240),
          meta: {
            ...(session.meta ?? {}),
            preset: target.preset,
            timeoutMs: target.timeoutMs,
          },
        });

        if (needsManualLogin) {
          const providerStatus = session.failureKind ?? "needs_manual_login";
          await this.store.recordProviderState({
            name: provider.name,
            status: providerStatus,
            lastError: session.detail,
            recoveryHint: provider.manualRecoveryHint(),
            meta: session.meta,
          });
          await this.notifier.notifyProviderAttention(provider.name, session.detail, provider.manualRecoveryHint());
          throw new ManualLoginRequiredError(provider.name, session.detail);
        }

        this.monitor.emit({
          type: "provider.failed",
          taskId: task.id,
          provider: provider.name,
          role: resolveRoleForPhase(phaseStatus),
          status: phaseStatus,
          detail: session.detail,
        });
        throw new Error(session.detail);
      }

      const handle = await provider.sendPrompt({
        taskId: task.id,
        taskType: task.type,
        prompt,
        inputSummary: summarizeText(prompt, 300),
        context: {
          workflowIntent: workflow.intent,
          artifactType: workflow.artifactType,
          phase: phaseStatus,
          userInput: task.normalizedInput,
        },
        execution: {
          role: target.role,
          preset: target.preset,
          timeoutMs: target.timeoutMs,
        },
      });
      const completion = await provider.waitForCompletion(handle);
      const result = await provider.extractAnswer(completion);
      if (isPromptLeakageOutput(result.outputText, task, prompt)) {
        throw new Error(`${provider.name} returned a prompt/template echo instead of a user-facing answer.`);
      }
      if (isProviderEnvironmentWarning(result.outputText)) {
        throw new Error(`${provider.name} returned a browser/environment warning instead of a user-facing answer.`);
      }

      await this.store.finishTaskStep(stepId, {
        status: "completed",
        outputSummary: result.summary,
        meta: {
          ...(result.meta ?? {}),
          preset: target.preset,
          timeoutMs: target.timeoutMs,
        },
      });
      this.monitor.emit({
        type: "provider.completed",
        taskId: task.id,
        provider: provider.name,
        role: resolveRoleForPhase(phaseStatus),
        status: phaseStatus,
        detail: result.summary,
        meta: {
          ...(result.meta ?? {}),
          preset: target.preset,
          timeoutMs: target.timeoutMs,
        },
      });
      this.monitor.heartbeat(resolveRoleForPhase(phaseStatus), {
        provider: provider.name,
        state: "idle",
        detail: "completed",
      });

      return {
        ...result,
        target,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      let screenshotPath: string | undefined;
      try {
        screenshotPath = await provider.screenshotOnFailure(task.id, error instanceof Error ? error : new Error(reason));
      } catch {
        screenshotPath = undefined;
      }

      await this.store.finishTaskStep(stepId, {
        status: "failed",
        outputSummary: summarizeText(reason, 240),
        meta: {
          ...(screenshotPath ? { screenshotPath } : {}),
          preset: target.preset,
          timeoutMs: target.timeoutMs,
        },
      });
      this.monitor.emit({
        type: "provider.failed",
        taskId: task.id,
        provider: provider.name,
        role: resolveRoleForPhase(phaseStatus),
        status: phaseStatus,
        detail: summarizeText(reason, 240),
        meta: {
          ...(screenshotPath ? { screenshotPath } : {}),
          preset: target.preset,
          timeoutMs: target.timeoutMs,
        },
      });
      this.monitor.heartbeat(resolveRoleForPhase(phaseStatus), {
        provider: provider.name,
        state: "error",
        detail: summarizeText(reason, 120),
      });

      const providerStatus = classifyFailureStatus(reason);
      if (providerStatus) {
        await this.store.recordProviderState({
          name: provider.name,
          status: providerStatus,
          lastError: reason,
          recoveryHint: provider.manualRecoveryHint(),
        });
      }

      throw error;
    }
  }

  private async runProviderPhaseWithFallback(
    task: TaskRecord,
    providerTargets: Array<ProviderExecutionTarget | string | undefined>,
    phaseStatus: TaskStatus,
    buildPrompt: (target: ProviderExecutionTarget) => string,
  ): Promise<{
    provider: string;
    target: ProviderExecutionTarget;
    outputText: string;
    summary: string;
    meta?: Record<string, unknown>;
  }> {
    const failures: string[] = [];
    let manualLoginError: ManualLoginRequiredError | null = null;

    const normalizedTargets = uniqueExecutionTargets(
      providerTargets
        .filter((entry): entry is ProviderExecutionTarget | string => Boolean(entry))
        .map((entry) => this.normalizeExecutionTarget(entry, phaseStatus, task)),
    );

    for (const target of normalizedTargets) {
      try {
        return await this.runProviderPhase(task, target, phaseStatus, buildPrompt(target));
      } catch (error) {
        if (error instanceof ManualLoginRequiredError) {
          manualLoginError = error;
        }
        failures.push(`${target.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (manualLoginError) {
      throw manualLoginError;
    }

    throw new Error(failures.join(" | "));
  }

  private normalizeExecutionTarget(
    providerRef: ProviderExecutionTarget | string | undefined,
    phaseStatus: TaskStatus,
    task: TaskRecord,
  ): ProviderExecutionTarget {
    if (providerRef && typeof providerRef === "object") {
      return providerRef;
    }

    if (!providerRef) {
      throw new Error(`No provider configured for ${phaseStatus}.`);
    }

    const provider = this.providers.get(providerRef);
    const config = provider?.getConfig();
    return {
      role: resolveRoleForPhase(phaseStatus),
      provider: providerRef,
      preset: config?.defaultPreset ?? "standard",
      timeoutMs: config?.timeoutMs ?? 90_000,
    };
  }

  private async loadLocalContext(task: TaskRecord, workflow: WorkflowMeta, includeWorkspaceContext = true): Promise<{
    backend: string;
    summary: string;
    referencedPaths: string[];
    notes?: string[];
  } | null> {
    const contextSections: string[] = [];
    const backendParts: string[] = [];
    const referencedPaths = new Set<string>();
    const notes: string[] = [];

    const sharedKnowledge = await this.loadSharedKnowledgeContext(task);
    if (sharedKnowledge) {
      backendParts.push(sharedKnowledge.backend);
      contextSections.push(sharedKnowledge.summary);
      for (const note of sharedKnowledge.notes ?? []) {
        notes.push(note);
      }
    }

    if (includeWorkspaceContext) {
      const baseContext = await this.localAccess.gatherContext({
        taskId: task.id,
        input: task.userInput,
        taskType: task.type,
        intent: workflow.intent,
        workspaceRoot: process.cwd(),
      });
      backendParts.push(baseContext.backend);
      contextSections.push(baseContext.summary);
      for (const path of baseContext.referencedPaths ?? []) {
        referencedPaths.add(path);
      }
      for (const note of baseContext.notes ?? []) {
        notes.push(note);
      }

      if (shouldInjectArchitectureContext(task, workflow)) {
        const enforcedContext = await buildArchitectureTaskContext(process.cwd());
        if (enforcedContext) {
          backendParts.push("architecture_bundle");
          contextSections.push(enforcedContext.summary);
          for (const path of enforcedContext.referencedPaths) {
            referencedPaths.add(path);
          }
          for (const note of enforcedContext.notes ?? []) {
            notes.push(note);
          }
        }
      }
    }

    if (contextSections.length === 0) {
      return null;
    }

    return {
      backend: backendParts.join("+"),
      summary: summarizeText(contextSections.filter(Boolean).join("\n\n"), 5_000),
      referencedPaths: [...referencedPaths],
      notes,
    };
  }

  private composePrompt(basePrompt: string, task: TaskRecord, localContext: { summary: string; backend: string } | null): string {
    const workflow = extractWorkflowMeta(task);
    const sections = [basePrompt];

    const skillPackBlock = renderSkillPackPromptBlock(workflow.selectedSkillPacks ?? []);
    if (skillPackBlock) {
      sections.push("", skillPackBlock);
    }

    if (localContext?.summary) {
      sections.push(
        "",
        "本地上下文摘要：",
        `(来源: ${localContext.backend})`,
        localContext.summary,
      );
    }

    return sections.join("\n");
  }

  private async loadSharedKnowledgeContext(task: TaskRecord): Promise<{
    backend: string;
    summary: string;
    notes?: string[];
  } | null> {
    const workflow = extractWorkflowMeta(task);
    const strictRelevance = task.type === "SIMPLE" && workflow.intent === "qa";
    const [working, episodic, longTerm] = await Promise.all([
      this.store.searchKnowledge({
        query: task.userInput,
        limit: 3,
        layers: ["working"],
      }),
      this.store.searchKnowledge({
        query: task.userInput,
        limit: 4,
        layers: ["episodic"],
      }),
      this.store.searchKnowledge({
        query: task.userInput,
        limit: 4,
        layers: ["long_term"],
      }),
    ]);
    const recent = strictRelevance ? [] : await this.store.listKnowledge(4);
    const entries = uniqueKnowledgeEntries([...working, ...episodic, ...longTerm, ...recent])
      .filter((entry) => isKnowledgeEntryUsableForTask(entry, task, strictRelevance))
      .slice(0, 10);
    if (entries.length === 0) {
      return null;
    }

    await this.store.touchKnowledge(entries.map((entry) => entry.id));
    return {
      backend: "layered_memory",
      summary: renderLayeredKnowledgeBlock(entries),
      notes: [
        `Loaded ${entries.length} memory entries.`,
        `working=${working.length}, episodic=${episodic.length}, long_term=${longTerm.length}`,
      ],
    };
  }

  private async persistKnowledgeFromTask(task: TaskRecord): Promise<void> {
    if (task.status !== "completed") {
      return;
    }

    const answer = extractTaskKnowledgeAnswer(task);
    if (!shouldPersistKnowledgeAnswer(task, answer)) {
      return;
    }
    const workflow = extractWorkflowMeta(task);
    const preference = isPreferenceLikeRequest(task.userInput);
    const layer = inferKnowledgeLayer(task, workflow, preference);
    const importance = inferKnowledgeImportance(task, workflow, preference);

    await this.store.upsertKnowledge({
      key: `task:${task.id}`,
      kind: preference ? "preference" : "task_history",
      layer,
      title: summarizeText(task.summary ?? task.userInput, 120),
      content: [
        `任务类型：${task.type}`,
        `任务意图：${workflow.intent}`,
        `用户需求：${summarizeText(task.normalizedInput, 900)}`,
        `最终结果：${summarizeText(answer || task.outputSummary || "", 1_600)}`,
      ].join("\n"),
      summary: summarizeText(answer || task.outputSummary || task.userInput, 240),
      tags: buildKnowledgeTags(task, workflow.intent),
      importance,
      source: task.source,
      sourceTaskId: task.id,
      pinned: preference,
    });
  }

  private async buildApprovalPlan(submission: TaskSubmission, taskType: TaskType, workflow: WorkflowMeta): Promise<TaskApprovalPlan> {
    const policies = await this.store.listApprovalPolicies().catch(() => [] as ApprovalPolicyRecord[]);
    if (policies.length === 0) {
      return {
        mode: "observe",
        matchedPolicies: [],
        reasons: [],
      };
    }

    const matched = policies.filter((policy) => matchesApprovalPolicy(policy, submission.input, taskType, workflow, inferRequestedRunner(submission.input)));
    const manual = matched.find((policy) => policy.mode === "manual");
    const mode = manual?.mode ?? matched.find((policy) => policy.mode === "auto")?.mode ?? "observe";

    return {
      mode,
      matchedPolicies: matched.map((policy) => policy.key),
      reasons: matched.map((policy) => policy.name),
    };
  }

  private applyRouteOverrides(task: TaskRecord, route: WorkflowRoutePlan): WorkflowRoutePlan {
    const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
    const overrides =
      sourceMeta.routeOverrides && typeof sourceMeta.routeOverrides === "object"
        ? (sourceMeta.routeOverrides as Record<string, unknown>)
        : null;

    if (!overrides) {
      return route;
    }

    const nextRoute: WorkflowRoutePlan = {
      ...route,
      reviewers: [...route.reviewers],
      fallbackProviders: [...route.fallbackProviders],
    };

    if (typeof overrides.draftProvider === "string" && this.providers.get(overrides.draftProvider)) {
      nextRoute.draftProvider = overrides.draftProvider;
    }

    if (Array.isArray(overrides.fallbackProviders)) {
      nextRoute.fallbackProviders = overrides.fallbackProviders.filter(
        (name): name is string => typeof name === "string" && Boolean(this.providers.get(name)),
      );
    }

    if (route.kind !== "image" && typeof overrides.finalArbiter === "string" && this.providers.get(overrides.finalArbiter)) {
      nextRoute.finalArbiter = overrides.finalArbiter;
    }

    if (route.kind !== "image" && Array.isArray(overrides.reviewers)) {
      nextRoute.reviewers = overrides.reviewers.filter(
        (name): name is string => typeof name === "string" && Boolean(this.providers.get(name)),
      );
    }

    if (typeof overrides.autoRunCodex === "boolean") {
      nextRoute.autoRunCodex = overrides.autoRunCodex;
    }

    return nextRoute;
  }

  private buildReviewPrompt(
    reviewer: string,
    task: TaskRecord,
    draftProvider: string,
    draftText: string,
  ): string {
    const workflow = extractWorkflowMeta(task);
    const docTaskGuardrails = buildDocTaskGuardrails(task);

    if (workflow.intent === "doc") {
      return [
        "你是文档复审模型。",
        ...docTaskGuardrails,
        "",
        `复审模型：${reviewer}`,
        `原始需求：${summarizeText(task.normalizedInput, 700)}`,
        `当前初稿：[${draftProvider}] ${summarizeText(draftText, 1_000)}`,
        "",
        "请按这个结构输出：",
        "1. 问题点",
        "2. 修订建议",
        "3. 最终意见",
        "",
        "要求：",
        "- 重点检查主体是否始终指向整个本地优先办公智能体系统，而不是当前模型节点",
        "- 重点检查是否仍出现“无法生成 Word/docx”“请手动复制到 Word”之类表述",
        "- 如果方向基本正确但仍需补充或纠偏，给出可执行修订建议",
        "- 不要输出思路过程",
      ].join("\n");
    }

    if (workflow.intent === "image") {
      return [
        "你是图片方案复审模型。",
        `原需求：${summarizeText(task.normalizedInput, 500)}`,
        `初稿：[${draftProvider}] ${summarizeText(draftText, 900)}`,
        "请输出：",
        "1. 提示词是否清晰",
        "2. 风格和构图是否明确",
        "3. 还缺哪些负面约束",
        "4. 给出简洁修订建议",
      ].join("\n");
    }

    if (workflow.intent === "video") {
      return [
        "你是视频方案复审模型。",
        `原需求：${summarizeText(task.normalizedInput, 500)}`,
        `初稿：[${draftProvider}] ${summarizeText(draftText, 900)}`,
        "请输出：",
        "1. 分镜是否完整",
        "2. 口播是否自然",
        "3. 节奏是否合理",
        "4. 还缺哪些素材和字幕要求",
      ].join("\n");
    }

    if (reviewer === "doubao_web") {
      return [
        "你是复审模型。",
        "请直接输出复审结论，不要展示思路过程。",
        "",
        `任务类型：${task.type}`,
        `原问题摘要：${summarizeText(task.normalizedInput, 420)}`,
        `草稿摘要：[${draftProvider}] ${summarizeText(draftText, 520)}`,
        "",
        "请按这个结构输出：",
        "1. 问题点",
        "2. 修订建议",
        "3. 最终意见",
        "",
        "要求：",
        "- 优先指出事实风险、执行风险、边界条件",
        "- 尽量简洁",
        "- 不要重复原文大段内容",
      ].join("\n");
    }

    if (reviewer === "gemini_web") {
      return [
        "你是复审模型。",
        "请直接输出复审结论，不要展示思路过程。",
        "",
        `任务类型：${task.type}`,
        `原问题摘要：${summarizeText(task.normalizedInput, 600)}`,
        `草稿摘要：[${draftProvider}] ${summarizeText(draftText, 700)}`,
        "",
        "请输出三部分：",
        "1. 问题点",
        "2. 修订建议",
        "3. 最终意见",
        "",
        "要求：",
        "- 优先指出事实风险、执行风险、边界条件",
        "- 如果草稿已足够好，也要明确说明",
        "- 尽量简洁，优先给可直接采用的复审意见",
      ].join("\n");
    }

    return renderTemplate(this.prompts.review, {
      userInput: task.normalizedInput,
      taskType: task.type,
      draft: `[${draftProvider}] ${draftText}`,
    });
  }

  private buildDraftPrompt(providerName: string, task: TaskRecord): string {
    const workflow = extractWorkflowMeta(task);
    const docTaskGuardrails = buildDocTaskGuardrails(task);
    const realtimeInfoNeed = workflow.intent === "qa" && task.type === "SIMPLE" && hasRealtimeInfoNeed(task.normalizedInput);

    if (realtimeInfoNeed) {
      return [
        "这是一个需要核对当前规则、公告或最新公开信息的问答。",
        "你必须先查找可验证的最新信息，优先引用官方活动页、官方公告、政务页面、APP 规则页等一手来源。",
        "不要凭常识猜，不要回答“通常这类活动会……”，也不要只让用户自己去查。",
        "如果查到了，先给结论，再给依据，明确写出关键规则点；如果涉及日期、时间、适用范围，必须写具体信息。",
        "如果暂时查不到足够依据，要明确说明“暂未查到可验证规则”，并指出还缺哪条关键信息。",
        `用户问题：${summarizeText(task.normalizedInput, 700)}`,
      ].join("\n");
    }

    if (workflow.intent === "doc") {
      return [
        "你是文档起草模型，请直接产出可交付的中文文档正文。",
        ...docTaskGuardrails,
        "如果用户范围略有歧义，请基于当前问题做最合理假设，并在开头用 1-2 句写明假设，不要把任务退回给用户。",
        "",
        `任务类型：${task.type}`,
        `原始需求：${summarizeText(task.normalizedInput, 900)}`,
        "",
        "输出要求：",
        "- 直接输出文档标题、摘要、正文结构",
        "- 默认采用适合复制到 Word 的层级结构",
        "- 不要出现“无法生成 Word”“请复制到 Word”“需要你手动排版”这类表述",
        "- 内容以交付为导向，保持简洁、清晰、可审阅",
      ].join("\n");
    }

    if (providerName === "doubao_web") {
      if (workflow.intent === "image") {
        const imageKind = getImageRequestKind(task);
        const subtypeGuide =
          imageKind === "edit"
            ? [
                "这是改图/重绘任务。",
                "优先保留原主体和核心元素，围绕用户要求修改风格、构图、材质、表情或细节。",
                "如果用户没有附原图，也要基于描述输出一版可直接执行的重绘提示词。",
              ]
            : imageKind === "avatar"
              ? [
                  "这是头像设计任务。",
                  "优先突出主体辨识度，默认适配 1:1 构图，注意脸部或主体居中、背景简洁。",
                ]
              : imageKind === "wallpaper"
                ? [
                    "这是壁纸设计任务。",
                    "优先考虑横屏或竖屏留白、图标遮挡区和整体耐看度，避免主体被裁切。",
                  ]
                : imageKind === "poster"
                  ? [
                      "这是海报/封面任务。",
                      "优先考虑标题区域、信息层级、主视觉冲击力和宣传用途。",
                    ]
                  : [
                      "这是新图生成任务。",
                      "请直接整理成一版高可用的出图提示词。",
                    ];

        return [
          "请直接输出可执行的图片生成结果，不要说自己不能出图。",
          ...subtypeGuide,
          "",
          "输出结构固定为：",
          "1. 主提示词",
          "2. 负面提示词",
          "3. 风格关键词",
          "4. 构图/镜头建议",
          "5. 尺寸与用途建议",
          "",
          `用户需求：${summarizeText(task.normalizedInput, 700)}`,
        ].join("\n");
      }

      if (workflow.intent === "video") {
        return [
          "请把用户需求整理成可直接执行的视频方案。",
          "输出结构：",
          "1. 视频定位",
          "2. 分镜脚本",
          "3. 口播文案",
          "4. 字幕关键词",
          "5. 素材清单",
          `用户需求：${summarizeText(task.normalizedInput, 700)}`,
        ].join("\n");
      }

      if (task.type === "SIMPLE") {
        return [
          "请直接用中文回答用户问题，不要解释你的角色，不要重复问题。",
          "如果问题涉及技术、学术、工程或专业概念，先给定义，再分点说明关键特征、优缺点、适用条件与边界，术语要准确。",
          "如果网页需要人工恢复登录，只输出“需要人工恢复登录”。",
          `用户问题：${summarizeText(task.normalizedInput, 500)}`,
        ].join("\n");
      }

      return [
        "你是本地优先办公智能体中的豆包网页模型节点。",
        "请直接输出适合办公场景的简洁结论和结构化建议。",
        "",
        `任务类型：${task.type}`,
        `用户输入：${summarizeText(task.normalizedInput, 700)}`,
        "",
        "要求：",
        "- 先给出简明结论",
        "- 再给出最多 5 条可执行建议",
        "- 不要泄露任何敏感信息",
        "- 如果网页需要人工恢复登录，请直接说明",
      ].join("\n");
    }

    if (providerName === "deepseek_web") {
      if (workflow.intent === "image") {
        return [
          "请复核这条图片任务是否清晰可执行，并补充风险与优化点。",
          `用户需求：${summarizeText(task.normalizedInput, 700)}`,
        ].join("\n");
      }

      if (workflow.intent === "video") {
        return [
          "请复核这条视频任务是否适合落地执行，并补充分镜与文案优化点。",
          `用户需求：${summarizeText(task.normalizedInput, 700)}`,
        ].join("\n");
      }

      return [
        "你是本地优先办公智能体中的 DeepSeek 网页模型节点。",
        "请优先输出简洁、可执行、适合直接回给办公用户的结果。",
        "如果问题涉及技术、学术、工程或专业概念，回答要专业、严谨，优先先下定义，再分点总结关键特征和边界。",
        "",
        `任务类型：${task.type}`,
        `用户输入：${summarizeText(task.normalizedInput, 700)}`,
        "",
        "要求：",
        "- 先给出简明结论",
        "- 再给出最多 5 条可执行建议",
        "- 不要泄露任何敏感信息",
        "- 如果网页需要人工恢复登录，请直接说明",
      ].join("\n");
    }

    return renderTemplate(this.prompts.drafting, {
      userInput: summarizeText(task.normalizedInput, 1_200),
      taskType: task.type,
    });
  }

  private buildArbitrationPrompt(
    task: TaskRecord,
    arbiter: string | undefined,
    draftProvider: string,
    draftText: string,
    reviewOutputs: Array<{ provider: string; text: string }>,
  ): string {
    const workflow = extractWorkflowMeta(task);
    const docTaskGuardrails = buildDocTaskGuardrails(task);

    if (workflow.intent === "doc") {
      const reviews =
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${summarizeText(entry.text, 700)}`).join("\n\n")
          : "暂无复审意见。";

      return [
        "你是文档任务的最终整合者。",
        ...docTaskGuardrails,
        "请直接输出适合交付的最终文档正文，不要输出元解释。",
        "",
        `原始需求：${summarizeText(task.normalizedInput, 700)}`,
        `初稿：[${draftProvider}] ${summarizeText(draftText, 1000)}`,
        `复审：${reviews}`,
        "",
        "要求：",
        "- 保留清晰标题和层级结构",
        "- 吸收复审意见，修正明显风险或歧义",
        "- 内容面向最终读者，不要面向系统或模型自己说话",
      ].join("\n");
    }

    if (workflow.intent === "image") {
      const reviews =
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${summarizeText(entry.text, 700)}`).join("\n\n")
          : "暂无复审意见。";

      return [
        "你是图片任务的最终整合者。",
        `用户需求：${summarizeText(task.normalizedInput, 500)}`,
        `初稿：[${draftProvider}] ${summarizeText(draftText, 900)}`,
        `复审：${reviews}`,
        "请输出最终版本，结构固定为：",
        "1. 主提示词",
        "2. 负面提示词",
        "3. 风格关键词",
        "4. 构图/镜头建议",
        "5. 尺寸与用途建议",
      ].join("\n");
    }

    if (workflow.intent === "video") {
      const reviews =
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${summarizeText(entry.text, 700)}`).join("\n\n")
          : "暂无复审意见。";

      return [
        "你是视频任务的最终整合者。",
        `用户需求：${summarizeText(task.normalizedInput, 500)}`,
        `初稿：[${draftProvider}] ${summarizeText(draftText, 900)}`,
        `复审：${reviews}`,
        "请输出最终版本，结构固定为：",
        "1. 视频定位",
        "2. 分镜脚本",
        "3. 口播文案",
        "4. 字幕关键词",
        "5. 素材清单",
      ].join("\n");
    }

    if (arbiter === "doubao_web") {
      const reviews =
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${summarizeText(entry.text, 650)}`).join("\n\n")
          : "暂无复审意见。";

      return [
        "你是最终仲裁者。",
        "请直接输出最终统一答复，不要展示思路过程。",
        "",
        `任务类型：${task.type}`,
        `原问题摘要：${summarizeText(task.normalizedInput, 500)}`,
        `草稿摘要：[${draftProvider}] ${summarizeText(draftText, 650)}`,
        `复审摘要：${reviews}`,
        "",
        "要求：",
        "- 解决冲突",
        "- 给出最终统一答复",
        "- 尽量简洁",
      ].join("\n");
    }

    if (arbiter === "chatgpt_web") {
      const reviews =
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${summarizeText(entry.text, 900)}`).join("\n\n")
          : "No reviewer feedback available.";

      return [
        "你是最终仲裁者。",
        "请直接输出最终统一答复，不要展示思路过程。",
        "",
        `任务类型：${task.type}`,
        `原问题摘要：${summarizeText(task.normalizedInput, 700)}`,
        `草稿摘要：[${draftProvider}] ${summarizeText(draftText, 900)}`,
        `复审摘要：${reviews}`,
        "",
        "要求：",
        "- 解决冲突",
        "- 给出最终统一答复",
        "- 若有不确定性，明确标注",
        "- 输出尽量适合直接发回给飞书用户",
      ].join("\n");
    }

    return renderTemplate(this.prompts.arbitration, {
      userInput: task.normalizedInput,
      taskType: task.type,
      draft: `[${draftProvider}] ${draftText}`,
      reviews:
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${entry.text}`).join("\n\n")
          : "No reviewer feedback available.",
    });
  }

  private buildCodingArbitrationPrompt(
    task: TaskRecord,
    arbiter: string | undefined,
    draftProvider: string,
    draftText: string,
    reviewOutputs: Array<{ provider: string; text: string }>,
  ): string {
    if (arbiter === "chatgpt_web") {
      const reviews =
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${summarizeText(entry.text, 900)}`).join("\n\n")
          : "No reviewer feedback available.";

      return [
        "你是编程任务仲裁者。",
        "请直接给出可执行的最终实施方案，不要展示思路过程。",
        "",
        `任务类型：${task.type}`,
        `原始需求摘要：${summarizeText(task.normalizedInput, 700)}`,
        `候选方案摘要：[${draftProvider}] ${summarizeText(draftText, 1000)}`,
        `复审摘要：${reviews}`,
        "",
        "输出要求：",
        "- 任务目标",
        "- 实施步骤",
        "- 影响文件",
        "- 风险点",
        "- 测试建议",
        "- 待确认项",
      ].join("\n");
    }

    return renderTemplate(this.prompts.codexHandoff, {
      userInput: task.normalizedInput,
      taskType: task.type,
      draft: `[${draftProvider}] ${draftText}`,
      reviews:
        reviewOutputs.length > 0
          ? reviewOutputs.map((entry) => `[${entry.provider}] ${entry.text}`).join("\n\n")
          : "No reviewer feedback available.",
    });
  }

  getMonitorSnapshot(limit?: number) {
    return this.monitor.getSnapshot(limit);
  }

  listMonitorEvents(limit?: number) {
    return this.monitor.listEvents(limit);
  }

  subscribeMonitor(listener: (event: MonitorEvent, snapshot: MonitorDashboardReport) => void) {
    return this.monitor.subscribe(listener);
  }

  listRoles() {
    return this.roleRegistry.list();
  }

  listSkills() {
    return this.skillRegistry.list();
  }

  listSkillPacks() {
    return this.skillRegistry.listPacks();
  }

  private async transitionTask(
    taskId: string,
    status: TaskStatus,
    currentTask: TaskRecord,
    workflow: WorkflowMeta,
    detail?: string,
  ): Promise<TaskRecord> {
    const updated = await this.store.updateTask(taskId, { status });
    this.monitor.recordTask(updated, workflow);
    this.monitor.emit({
      type: "task.status_changed",
      taskId,
      status,
      detail,
      meta: {
        workflow,
      },
    });
    this.monitor.heartbeat("crown_orchestrator", {
      state: status === "completed" || status === "failed" ? "idle" : "running",
      detail: status,
    });
    return {
      ...currentTask,
      ...updated,
    };
  }

  private async persistWorkflow(taskId: string, task: TaskRecord, workflow: WorkflowMeta): Promise<TaskRecord> {
    const updated = await this.store.updateTask(taskId, {
      sourceMeta: {
        ...(task.sourceMeta ?? {}),
        workflow,
      },
    });
    this.monitor.recordTask(updated, workflow);
    return updated;
  }

  private async escalateForHumanReview(
    task: TaskRecord,
    workflow: WorkflowMeta,
    audit: AuditResult,
    answer: string,
    provider: string,
  ): Promise<TaskRecord> {
    const updated = await this.store.updateTask(task.id, {
      status: "needs_human_intervention",
      error: summarizeText(`审核未通过: ${audit.rawText}`, 400),
      result: {
        ...(task.result ?? {}),
        answer,
        provider,
        audit,
      },
    });
    this.monitor.recordTask(updated, workflow);
    this.monitor.emit({
      type: "audit.rejected",
      taskId: task.id,
      status: updated.status,
      provider,
      role: "menxia_auditor",
      detail: audit.rawText,
      meta: {
        audit,
      },
    });
    return updated;
  }

  private async runAuditLoop(
    task: TaskRecord,
    workflow: WorkflowMeta,
    route: WorkflowRoutePlan,
    payload: {
      answer: string;
      provider: string;
      providerTarget?: ProviderExecutionTarget;
      providerMeta?: Record<string, unknown>;
      reviewOutputs: Array<{ provider: string; text: string; meta?: Record<string, unknown>; target?: ProviderExecutionTarget }>;
      failures: string[];
      localContext: { summary: string; backend: string } | null;
      draftOutput?: { provider: string; text: string; summary?: string; meta?: Record<string, unknown>; target?: ProviderExecutionTarget } | null;
    },
  ): Promise<{
    status: "ok";
    answer: string;
    provider: string;
    providerMeta?: Record<string, unknown>;
    audit?: AuditResult;
  } | {
    status: "needs_human_intervention";
    answer: string;
    provider: string;
    providerMeta?: Record<string, unknown>;
    audit?: AuditResult;
    task: TaskRecord;
  }> {
    if (!this.auditEngine.shouldAudit(workflow)) {
      return {
        status: "ok",
        answer: payload.answer,
        provider: payload.provider,
        providerMeta: payload.providerMeta,
      };
    }

    const auditTargetChain = uniqueExecutionTargets([
      route.auditTarget,
      ...(route.auditFallbackTargets ?? []),
      payload.providerTarget,
      route.finalArbiterTarget,
      ...(route.reviewerTargets ?? []),
      ...(route.fallbackTargets ?? []),
      route.draftTarget,
    ]);
    const auditTarget = auditTargetChain[0];
    const auditProvider = auditTarget?.provider ?? route.finalArbiter ?? route.reviewers[0] ?? route.draftProvider;
    this.monitor.emit({
      type: "audit.required",
      taskId: task.id,
      status: task.status,
      provider: auditProvider,
      role: "menxia_auditor",
      detail: workflow.audit.triggers.join(", "),
      meta: {
        audit: workflow.audit,
        targets: auditTargetChain,
        current: auditTarget,
      },
    });

    let currentAnswer = payload.answer;
    let currentProvider = payload.provider;
    let currentProviderMeta = payload.providerMeta;
    let lastAudit: AuditResult | undefined;

    for (let round = 0; round <= workflow.audit.maxRevisionRounds; round += 1) {
      const roundAuditTargetChain =
        round === 0
          ? auditTargetChain
          : uniqueExecutionTargets([
              ...prioritizeEscalatedAuditTargets(auditTargetChain),
              ...auditTargetChain,
            ]);

      const auditRun = await this.runProviderPhaseWithFallback(task, roundAuditTargetChain, "audit_pending", () =>
        this.composePrompt(
          this.auditEngine.buildAuditPrompt({
            task,
            workflow,
            currentAnswer,
            draftProvider: currentProvider,
          }),
          task,
          payload.localContext,
        ),
      );
      lastAudit = this.auditEngine.parseAuditResult(auditRun.outputText, workflow.riskLevel);
      const mustReviseBeforeArtifact =
        workflow.intent === "doc" &&
        lastAudit.decision === "pass" &&
        auditContainsRevisionHints(lastAudit) &&
        round < workflow.audit.maxRevisionRounds;

      if (lastAudit.decision === "pass" && !mustReviseBeforeArtifact) {
        this.monitor.emit({
          type: "audit.passed",
          taskId: task.id,
          status: "audit_pending",
          provider: auditRun.provider,
          role: "menxia_auditor",
          detail: summarizeText(lastAudit.rawText, 220),
          meta: {
            audit: lastAudit,
            preset: auditRun.target.preset,
          },
        });
        return {
          status: "ok",
          answer: currentAnswer,
          provider: currentProvider,
          providerMeta: currentProviderMeta,
          audit: lastAudit,
        };
      }

      if (lastAudit.decision === "reject") {
        this.monitor.emit({
          type: "audit.rejected",
          taskId: task.id,
          status: "audit_pending",
          provider: auditRun.provider,
          role: "menxia_auditor",
          detail: summarizeText(lastAudit.rawText, 220),
          meta: {
            audit: lastAudit,
            round,
            preset: auditRun.target.preset,
            recoverable: round < workflow.audit.maxRevisionRounds,
          },
        });
      }

      if (round >= workflow.audit.maxRevisionRounds) {
        const escalated = await this.escalateForHumanReview(task, workflow, lastAudit, currentAnswer, currentProvider);
        return {
          status: "needs_human_intervention",
          answer: typeof escalated.result?.answer === "string" ? escalated.result.answer : currentAnswer,
          provider: currentProvider,
          providerMeta: currentProviderMeta,
          audit: lastAudit,
          task: escalated,
        };
      }

      this.monitor.emit({
        type: "audit.revise_required",
        taskId: task.id,
        status: "audit_revising",
        provider: auditRun.provider,
        role: "menxia_auditor",
        detail: summarizeText(lastAudit.rawText, 220),
        meta: {
          audit: lastAudit,
          round,
          preset: auditRun.target.preset,
          originalDecision: mustReviseBeforeArtifact ? "pass_with_suggestions" : lastAudit.decision,
        },
      });
      this.monitor.incrementAuditRound(task.id);

      const reviserProviderChain = uniqueExecutionTargets([
        payload.providerTarget,
        route.finalArbiterTarget,
        ...(route.auditFallbackTargets ?? []),
        ...(route.reviewerTargets ?? []),
        payload.providerTarget,
        ...(route.fallbackTargets ?? []),
        route.draftTarget,
      ]);
      const revisionRun = await this.runProviderPhaseWithFallback(task, reviserProviderChain, "audit_revising", () =>
        this.composePrompt(
          this.auditEngine.buildRevisionPrompt({
            task,
            workflow,
            currentAnswer,
            auditResult: lastAudit!,
          }),
          task,
          payload.localContext,
        ),
      );
      currentAnswer = revisionRun.outputText;
      currentProvider = revisionRun.provider;
      payload.providerTarget = revisionRun.target;
      currentProviderMeta = revisionRun.meta;
    }

    return {
      status: "ok",
      answer: currentAnswer,
      provider: currentProvider,
      providerMeta: currentProviderMeta,
      audit: lastAudit,
    };
  }
}

function getImageRequestKind(task: TaskRecord): string | undefined {
  const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
  return typeof sourceMeta.imageRequestKind === "string" ? sourceMeta.imageRequestKind : undefined;
}

function uniqueProviders(providerNames: Array<string | undefined>): string[] {
  return [...new Set(providerNames.filter((providerName): providerName is string => typeof providerName === "string" && providerName.length > 0))];
}

function uniqueExecutionTargets(
  targets: Array<ProviderExecutionTarget | undefined>,
): ProviderExecutionTarget[] {
  const seen = new Set<string>();
  const result: ProviderExecutionTarget[] = [];
  for (const target of targets) {
    if (!target) {
      continue;
    }
    const key = `${target.provider}:${target.preset}:${target.role}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(target);
  }
  return result;
}

function resolveRoleForPhase(status: TaskStatus): TaskRoleAssignment["role"] {
  if (status === "reviewing") {
    return "hanlin_reviewer";
  }
  if (status === "audit_pending" || status === "audit_revising") {
    return "menxia_auditor";
  }
  if (status === "arbitrating") {
    return "zhongshu_arbiter";
  }
  if (status === "handoff_to_codex" || status === "implementing" || status === "testing") {
    return "junji_implementer";
  }
  return "zhongshu_drafter";
}

function resolveLocalSimpleShortcut(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  const raw = input.trim();

  if (/^(你好|您好|hi|hello|hey)[!！。. ]*$/.test(normalized)) {
    return "你好呀～有啥我能帮忙的？😊";
  }

  if (/(你是谁|你是什么模型|你是什么|介绍一下你自己)/.test(normalized)) {
    return "我是你的本地办公小助手～平时可以陪你聊天、写文档、做 PPT、画图，编程任务也能交给 Codex 搞定，有啥尽管说！";
  }

  if (/(你能做什么|你可以做什么|help|帮助)/.test(normalized)) {
    return "我能做的还挺多的～日常聊天、写文档、做 PPT、拆解复杂任务、汇总多模型意见，编程需求也能整理好交给 Codex。试试看？";
  }

  if (/(现在.*几点|几点了|现在时间|当前时间)/.test(normalized)) {
    const time = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Shanghai",
    }).format(new Date());
    return `现在是北京时间 ${time}。`;
  }

  if (/^(谢谢|谢了|thanks|thank you)[!！。. ]*$/.test(normalized)) {
    return "不客气～随时找我 😄";
  }

  if (/^(早上好|中午好|下午好|晚上好)[!！。. ]*$/.test(normalized)) {
    return `${raw.replace(/[!！。. ]+$/g, "")}呀～有什么我可以帮你的？`;
  }

  return null;
}

function classifyFailureStatus(
  message: string,
): "needs_manual_login" | "needs_browser_launch" | "provider_session_lost" | null {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("connect econrefused")
    || normalized.includes("retrieving websocket url")
    || normalized.includes("connectovercdp")
  ) {
    return "needs_browser_launch";
  }

  if (
    normalized.includes("login is missing or expired")
    || normalized.includes("requires manual recovery")
    || normalized.includes("blocked/risk-control page")
    || normalized.includes("blocked page")
  ) {
    return "needs_manual_login";
  }

  if (
    normalized.includes("target page, context or browser has been closed")
    || normalized.includes("page session was not initialized")
    || normalized.includes("browser has been closed")
    || normalized.includes("context closed")
  ) {
    return "provider_session_lost";
  }

  return null;
}

function resolveFailureStatus(
  failures: string[],
): "failed" | "needs_manual_login" | "needs_browser_launch" | "provider_session_lost" {
  if (failures.some((entry) => classifyFailureStatus(entry) === "needs_browser_launch")) {
    return "needs_browser_launch";
  }
  if (failures.some((entry) => classifyFailureStatus(entry) === "provider_session_lost")) {
    return "provider_session_lost";
  }
  if (failures.some((entry) => classifyFailureStatus(entry) === "needs_manual_login")) {
    return "needs_manual_login";
  }
  return "failed";
}

function extractWorkflowMeta(task: TaskRecord): WorkflowMeta {
  const workflow = ((task.sourceMeta ?? {}) as Record<string, unknown>).workflow as Partial<WorkflowMeta> | undefined;
  return {
    tier: workflow?.tier ?? "T2",
    intent: workflow?.intent ?? inferIntentFromTaskType(task.type),
    budget: workflow?.budget ?? "standard",
    artifactType: workflow?.artifactType ?? "none",
    qualityLevel: workflow?.qualityLevel ?? "standard",
    riskLevel: workflow?.riskLevel ?? "low",
    complexity: workflow?.complexity ?? (task.type === "CODING" ? "hard" : task.type === "COMPLEX" ? "medium" : "easy"),
    complexityScore: workflow?.complexityScore ?? (task.type === "CODING" ? 0.8 : task.type === "COMPLEX" ? 0.65 : 0.2),
    audit: workflow?.audit ?? {
      requested: false,
      required: false,
      triggers: [],
      strategy: "structured_gate",
      maxRevisionRounds: 0,
      maxAttempts: 3,
    },
    selectedSkills: workflow?.selectedSkills ?? [],
    rolePlan: workflow?.rolePlan,
    modelPlan: workflow?.modelPlan,
    presetHints: workflow?.presetHints,
    executionPolicy: workflow?.executionPolicy,
  };
}

type TaskContinuation = {
  fromTaskId: string;
  restartPhase?: "audit_pending";
  followupText?: string;
  previousAnswer?: string;
  previousProvider?: string;
  previousProviderMeta?: Record<string, unknown>;
  previousDraftOutput?: {
    provider: string;
    text: string;
    summary?: string;
    meta?: Record<string, unknown>;
  };
  previousReviewOutputs?: Array<{
    provider: string;
    text: string;
    meta?: Record<string, unknown>;
  }>;
  previousFailures?: string[];
  localContextSummary?: string;
};

function extractContinuation(task: TaskRecord): TaskContinuation | null {
  const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
  const raw = sourceMeta.continuation;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.fromTaskId !== "string") {
    return null;
  }

  const draftOutput = normalizeContinuationDraftOutput(record.previousDraftOutput);
  const reviewOutputs = Array.isArray(record.previousReviewOutputs)
    ? record.previousReviewOutputs
        .map((entry) => normalizeContinuationReviewOutput(entry))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : undefined;

  return {
    fromTaskId: record.fromTaskId,
    restartPhase: record.restartPhase === "audit_pending" ? "audit_pending" : undefined,
    followupText: typeof record.followupText === "string" ? record.followupText : undefined,
    previousAnswer: typeof record.previousAnswer === "string" ? record.previousAnswer : undefined,
    previousProvider: typeof record.previousProvider === "string" ? record.previousProvider : undefined,
    previousProviderMeta:
      record.previousProviderMeta && typeof record.previousProviderMeta === "object"
        ? (record.previousProviderMeta as Record<string, unknown>)
        : undefined,
    previousDraftOutput: draftOutput ?? undefined,
    previousReviewOutputs: reviewOutputs && reviewOutputs.length > 0 ? reviewOutputs : undefined,
    previousFailures: Array.isArray(record.previousFailures)
      ? record.previousFailures.filter((item): item is string => typeof item === "string")
      : undefined,
    localContextSummary: typeof record.localContextSummary === "string" ? record.localContextSummary : undefined,
  };
}

function normalizeContinuationDraftOutput(value: unknown): TaskContinuation["previousDraftOutput"] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.text !== "string") {
    return null;
  }
  return {
    provider: record.provider,
    text: record.text,
    summary: typeof record.summary === "string" ? record.summary : undefined,
    meta: record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : undefined,
  };
}

function normalizeContinuationReviewOutput(
  value: unknown,
): { provider: string; text: string; meta?: Record<string, unknown> } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.text !== "string") {
    return null;
  }
  return {
    provider: record.provider,
    text: record.text,
    meta: record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : undefined,
  };
}

function inferIntentFromTaskType(taskType: TaskType): TaskIntent {
  if (taskType === "CODING") {
    return "coding";
  }
  if (taskType === "COMPLEX") {
    return "office_discussion";
  }
  return "qa";
}

function isPromptTemplateEcho(outputText: string, task: TaskRecord, prompt?: string): boolean {
  const normalizedOutput = normalizeEchoText(outputText);
  if (!normalizedOutput) {
    return false;
  }

  const normalizedPrompt = normalizeEchoText(prompt ?? "");
  const normalizedInput = normalizeEchoText(task.normalizedInput);
  const promptLineHits = countPromptLineHits(normalizedOutput, prompt);
  const markerHits = PROMPT_ECHO_MARKERS.filter((marker) => normalizedOutput.includes(marker)).length;

  if (normalizedPrompt && normalizedOutput.includes(normalizedPrompt)) {
    return true;
  }

  if (PROMPT_ECHO_START_MARKERS.some((marker) => normalizedOutput.startsWith(marker))) {
    return true;
  }

  if (promptLineHits >= 2) {
    return true;
  }

  if (markerHits >= 3) {
    return true;
  }

  if (markerHits >= 2 && normalizedInput && normalizedOutput.includes(normalizedInput)) {
    return true;
  }

  return false;
}

function isPromptLeakageOutput(outputText: string, task: TaskRecord, prompt?: string): boolean {
  if (isPromptTemplateEcho(outputText, task, prompt)) {
    return true;
  }

  return countMarkerHits(outputText, PROMPT_LEAKAGE_MARKERS) >= 3;
}

function isProviderEnvironmentWarning(outputText: string): boolean {
  const normalizedOutput = normalizeEchoText(outputText);
  if (!normalizedOutput) {
    return false;
  }

  return PROVIDER_ENVIRONMENT_WARNING_MARKERS.some((marker) => normalizedOutput.includes(marker));
}

function normalizeEchoText(input: string): string {
  return normalizeWhitespace(input)
    .replace(/[。.!?,，：:;；"'`“”‘’]/gu, "")
    .replace(/[-*]/g, " ")
    .toLowerCase();
}

function countPromptLineHits(normalizedOutput: string, prompt?: string): number {
  if (!prompt) {
    return 0;
  }

  const lines = prompt
    .split("\n")
    .map((line) => normalizeEchoText(line))
    .filter((line) => line.length >= 8 && line.length <= 160);

  return [...new Set(lines)].filter((line) => normalizedOutput.includes(line)).length;
}

const PROMPT_ECHO_MARKERS = [
  "你是本地优先办公智能体中的",
  "请直接用中文简洁回答用户问题",
  "不要解释你的角色",
  "不要重复问题",
  "任务类型",
  "用户输入",
  "用户问题",
  "原问题摘要",
  "草稿摘要",
  "本地上下文摘要",
  "分层记忆摘要",
  "要求",
  "先给出简明结论",
  "再给出最多 5 条可执行建议",
  "不要泄露任何敏感信息",
  "如果网页需要人工恢复登录",
].map(normalizeEchoText);

const PROMPT_ECHO_START_MARKERS = [
  "请直接用中文简洁回答用户问题",
  "你是本地优先办公智能体中的",
  "你是编程任务仲裁者",
  "本地上下文摘要",
  "可用本地上下文摘要",
  "分层记忆摘要",
  "原始需求",
  "候选方案",
].map(normalizeEchoText);

const PROMPT_LEAKAGE_MARKERS = [
  ...PROMPT_ECHO_MARKERS,
  "本地上下文摘要",
  "可用本地上下文摘要",
  "分层记忆摘要",
  "来源: layered_memory",
  "来源: layered_memory+native_reader",
  "请直接用中文简洁回答用户问题",
  "不要解释你的角色",
  "不要重复问题",
  "用户问题",
].map(normalizeEchoText);

const PROVIDER_ENVIRONMENT_WARNING_MARKERS = [
  "some privacy related extensions may cause issues on xcom please disable them and try again",
  "privacy related extensions may cause issues on xcom",
].map(normalizeEchoText);

function countMarkerHits(input: string, markers: string[]): number {
  const normalized = normalizeEchoText(input);
  if (!normalized) {
    return 0;
  }

  return markers.filter((marker) => normalized.includes(marker)).length;
}

function shouldDirectToCodex(task: TaskRecord): boolean {
  const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
  const overrides = sourceMeta.routeOverrides;
  if (!overrides || typeof overrides !== "object") {
    return false;
  }

  return (overrides as Record<string, unknown>).directToCodex === true;
}

function getDirectCliRunner(task: TaskRecord): "codex" | "gemini" {
  const sourceMeta = (task.sourceMeta ?? {}) as Record<string, unknown>;
  const overrides = sourceMeta.routeOverrides;
  if (!overrides || typeof overrides !== "object") {
    return "codex";
  }

  return (overrides as Record<string, unknown>).directCliRunner === "gemini" ? "gemini" : "codex";
}

function getDirectCliRunnerLabel(runner: "codex" | "gemini"): string {
  return runner === "gemini" ? "Gemini CLI" : "Codex";
}

function buildDirectCodexBundle(
  task: TaskRecord,
  localContext: { summary: string; backend: string } | null,
): CodingHandoffBundle {
  const runner = getDirectCliRunner(task);
  const runnerLabel = getDirectCliRunnerLabel(runner);
  const contextLines =
    localContext?.summary
      ? ["", "可用本地上下文摘要：", `(来源: ${localContext.backend})`, localContext.summary]
      : [];

  return {
    taskId: task.id,
    originalRequest: task.userInput,
    explicitRunner: runner,
    candidatePlans: [
      {
        provider: runner === "gemini" ? "direct_to_gemini_cli" : "direct_to_codex",
        plan: `跳过网页模型起草与复审，直接把原始请求交给 ${runnerLabel} 在本地执行。`,
      },
    ],
    finalPlan: [
      `请直接使用 ${runnerLabel} 在本地工作区执行用户请求，不要只返回操作说明。`,
      "如果任务涉及查看、打开、整理、分析或修改本地文件/文件夹，请优先实际执行，再用简短结果收尾。",
      "",
      `用户原始请求：${task.userInput}`,
      ...contextLines,
    ].join("\n"),
    risks: [
      "Local filesystem actions should stay within the intended workspace or explicitly requested paths.",
      "If the requested path is outside the default workspace, Codex may need extra writable directories.",
      "Explain clearly when execution is blocked by sandbox, permissions, or missing files.",
    ],
    impactedFiles: ["待 Codex 执行时确定"],
    testingSuggestions: [
      "If files were changed, run the minimal relevant verification.",
      "If no edits were needed, report the actual actions taken instead of giving generic instructions.",
    ],
    unresolvedQuestions: [
      "Whether the requested target path falls outside the current Codex workspace allowance.",
    ],
  };
}

function summarizeDirectCliExecution(
  runnerLabel: string,
  execution: { stdout: string; stderr: string; success: boolean } | null,
  autoRunEnabled: boolean,
): string {
  if (!execution) {
    return autoRunEnabled
      ? `已生成 ${runnerLabel} 交接产物，但当前环境未实际执行。`
      : `已生成 ${runnerLabel} 交接产物，等待后续执行。`;
  }

  if (!execution.success) {
    return `${runnerLabel} 执行失败：${summarizeText(stripAnsi(execution.stderr || execution.stdout || "execution failed"), 180)}`;
  }

  const summary = summarizeText(stripAnsi(execution.stdout).trim(), 220);
  return summary || `已由 ${runnerLabel} 执行完成。`;
}

function detectCliAuthorizationMessage(runnerLabel: string, raw: string): string | null {
  const normalized = stripAnsi(raw).toLowerCase();
  if (!normalized) {
    return null;
  }

  const markers = [
    "approval",
    "allow",
    "permission denied",
    "access denied",
    "operation not permitted",
    "requires elevated",
    "sandbox",
    "authorization",
    "not permitted",
    "need permission",
    "requires permission",
    "需要授权",
    "权限",
    "批准",
  ];

  if (!markers.some((marker) => normalized.includes(marker))) {
    return null;
  }

  return `${runnerLabel} 需要额外授权后才能继续：${summarizeText(stripAnsi(raw), 220)}`;
}

function detectPermissionLimitedWriteCompletion(input: string, raw: string): string | null {
  if (!looksLikeWriteTask(input)) {
    return null;
  }

  const normalized = stripAnsi(raw).toLowerCase();
  if (!normalized) {
    return null;
  }

  const markers = [
    "read-only",
    "readonly",
    "只读",
    "cannot write",
    "can't write",
    "failed to write",
    "write access",
    "apply_patch",
    "permission denied",
    "eacces",
    "sandbox",
    "无法写入",
    "不能写入",
    "未实际写入",
    "没法直接在仓库里落地",
    "无法写入文件",
    "策略拒绝",
    "被策略拒绝",
  ];

  if (!markers.some((marker) => normalized.includes(marker))) {
    return null;
  }

  return `Codex 当前只完成了只读分析，尚未真正写入文件；请在飞书中批准后继续执行。`;
}

function shouldPauseForPermissionLimitedWrite(input: string, raw: string, generatedArtifactCount: number): boolean {
  if (generatedArtifactCount > 0) {
    return false;
  }

  return detectPermissionLimitedWriteCompletion(input, raw) !== null;
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

function looksLikeWriteTask(input: string): boolean {
  return /(修复|修一下|改一下|改下|改一改|修改|实现|重构|新增|创建|删除|重命名|写入|改代码|fix|edit|modify|implement|refactor|create|delete|rename|write)/iu.test(input);
}

function buildAuthorizationResumePrompt(task: TaskRecord): string {
  return [
    "The user approved the filesystem changes and wants this same task to continue.",
    "Please continue from the failed permission-limited step, complete the original request, and stop after reporting the concrete result.",
    "",
    `Original request: ${task.userInput}`,
  ].join("\n");
}

function buildCodingBundle(
  task: TaskRecord,
  proposals: Array<{ provider: string; plan: string }>,
  finalPlan: string,
): CodingHandoffBundle {
  return {
    taskId: task.id,
    originalRequest: task.userInput,
    explicitRunner: inferRequestedRunner(task.userInput) ?? undefined,
    candidatePlans: proposals,
    finalPlan,
    risks: [
      "Web provider selectors may need refresh if upstream DOM changes.",
      "Feishu bot callbacks depend on app credentials and event subscription configuration.",
      "Codex CLI invocation is optional and may require local user confirmation.",
    ],
    impactedFiles: [
      "apps/server/src/**/*",
      "packages/core/src/**/*",
      "packages/providers/**/*",
    ],
    testingSuggestions: [
      "Run pnpm test for smoke coverage.",
      "Verify POST /feishu/events with a mock event payload.",
      "Trigger a SIMPLE task and confirm task audit trail in GET /tasks/:id.",
    ],
    unresolvedQuestions: [
      "Whether Codex CLI should auto-run or stay in artifact-only mode.",
      "Whether more real web providers should be enabled after selector validation.",
    ],
  };
}

function buildCodingCandidatePlans(
  draftOutput: { provider: string; text: string },
  reviewOutputs: Array<{ provider: string; text: string }>,
  arbiterProvider: string | undefined,
  finalPlan: string,
): Array<{ provider: string; plan: string }> {
  const proposals: Array<{ provider: string; plan: string }> = [{ provider: draftOutput.provider, plan: draftOutput.text }];

  for (const review of reviewOutputs) {
    if (review.text.trim()) {
      proposals.push({ provider: review.provider, plan: review.text });
    }
  }

  if (arbiterProvider && finalPlan.trim()) {
    proposals.push({ provider: arbiterProvider, plan: finalPlan });
  }

  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    const key = `${proposal.provider}:${proposal.plan}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getNestedText(result: Record<string, unknown> | null | undefined, key: string, nestedKey: string): string | null {
  if (!result) {
    return null;
  }

  const value = result[key];
  if (!value || typeof value !== "object") {
    return null;
  }

  const nested = (value as Record<string, unknown>)[nestedKey];
  return typeof nested === "string" ? nested : null;
}

function getFirstReviewText(result: Record<string, unknown> | null | undefined): string | null {
  const reviews = result?.reviewOutputs;
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return null;
  }

  const first = reviews[0] as Record<string, unknown>;
  return typeof first.text === "string" ? first.text : null;
}

function getLocalContextSummary(result: Record<string, unknown> | null | undefined): string | null {
  const localContext = result?.localContext;
  if (!localContext || typeof localContext !== "object") {
    return null;
  }

  const summary = (localContext as Record<string, unknown>).summary;
  return typeof summary === "string" ? summary : null;
}

function buildDocTaskGuardrails(task: TaskRecord): string[] {
  return [
    "任务主体固定为“本地优先办公智能体系统”整体，不是当前起草/复审/审核模型节点自己。",
    "如果用户写“你现在的架构”“你当前的架构”，这里的“你”都指上面的整个系统，而不是当前网页模型。",
    "必须按系统整体架构来写：包括编排器、路由、角色分工、模型/provider、审核机制、监控、执行与产物链路等系统级内容。",
    "必须面向最终交付写作，不要介绍当前模型节点自己的能力、限制、身份或运行环境。",
    "不要解释你是否能生成 Word/docx，也不要讨论模型能力边界。",
    "必须按会生成 docx 成品的前提来组织正文，不允许出现“无法生成 Word/docx”“请复制到 Word”“需要手动排版”这类表述。",
    "如果任务没有明确提供日期、版本号、客户端形态、API Key 管理方式、部署形态、外部产品名称等事实，请不要编造；未知就省略，或写成“按当前仓库可见信息未见明确配置”。",
    "如果没有从本地上下文中看到明确证据，不要自行写入 Web 端、桌面客户端、统一 API Key 配额管理、企业内网部署等设定。",
    "如果版本号、日期、密级、供应商名单等元数据未提供，优先省略，不要写“待定”“待确认”或其他占位符。",
    `用户原始需求：${summarizeText(task.normalizedInput, 700)}`,
  ];
}

function auditContainsRevisionHints(audit: AuditResult): boolean {
  return audit.issues.length > 0 || audit.suggestions.length > 0;
}

function shouldInjectArchitectureContext(task: TaskRecord, workflow: WorkflowMeta): boolean {
  if (workflow.intent !== "doc") {
    return false;
  }

  return /(架构|architecture|框架|系统说明|系统设计|治理架构|编排系统)/iu.test(task.normalizedInput);
}

async function buildArchitectureTaskContext(workspaceRoot: string): Promise<{
  summary: string;
  referencedPaths: string[];
  notes: string[];
} | null> {
  const files = [
    "docs/agent-governance-architecture.md",
    "config/roles.yaml",
    "config/routing-policy.yaml",
    "config/providers.yaml",
  ];

  const chunks: string[] = [];
  const referencedPaths: string[] = [];

  for (const relativePath of files) {
    const absolutePath = resolve(workspaceRoot, relativePath);
    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (!content) {
      continue;
    }

    referencedPaths.push(relativePath);
    const limit = relativePath.endsWith("providers.yaml") ? 2_200 : 1_800;
    chunks.push(`文件 ${relativePath}:\n${summarizeText(content, limit)}`);
  }

  if (chunks.length === 0) {
    return null;
  }

  return {
    summary: [
      "架构任务强制上下文：以下内容来自当前仓库内的真实文档与配置，请优先依据这些内容写作，不要用通用企业模板补空。",
      ...chunks,
    ].join("\n\n"),
    referencedPaths,
    notes: ["Architecture task received enforced repository context bundle."],
  };
}

async function collectDeliverableArtifacts(
  taskDir: string,
  outputTexts: Array<string | undefined> = [],
): Promise<Array<{ label: string; path: string }>> {
  const entries = await readdir(taskDir, { withFileTypes: true }).catch(() => []);
  const deliverables: Array<{ label: string; path: string }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const path = resolve(taskDir, entry.name);
    if (!/\.(png|jpe?g|webp|gif|bmp|tiff|pdf|docx?|pptx?)$/iu.test(entry.name)) {
      continue;
    }

    seen.add(path);
    deliverables.push({
      label: inferDeliverableLabel(entry.name),
      path,
    });
  }

  const referencedPaths = await collectReferencedArtifactPaths(outputTexts);
  for (const path of referencedPaths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    deliverables.push({
      label: inferDeliverableLabel(path),
      path,
    });
  }

  return deliverables;
}

function inferDeliverableLabel(fileName: string): string {
  if (/\.(png|jpe?g|webp|gif|bmp|tiff)$/iu.test(fileName)) {
    return "generated_image";
  }
  if (/\.pptx?$/iu.test(fileName)) {
    return "generated_presentation";
  }
  if (/\.pdf$/iu.test(fileName)) {
    return "generated_pdf";
  }
  if (/\.docx?$/iu.test(fileName)) {
    return "generated_document";
  }
  return "artifact";
}

async function collectReferencedArtifactPaths(outputTexts: Array<string | undefined>): Promise<string[]> {
  const candidates = new Set<string>();
  for (const text of outputTexts) {
    if (!text) {
      continue;
    }

    for (const match of text.matchAll(/\[[^\]]+\]\((\/[^)\s]+\.(?:png|jpe?g|webp|gif|bmp|tiff|pdf|docx?|pptx?))\)/giu)) {
      const path = match[1];
      if (path) {
        candidates.add(path);
      }
    }

    for (const match of text.matchAll(/(?:^|[\s`"])(\/(?:tmp|home)\/[^\s`"]+\.(?:png|jpe?g|webp|gif|bmp|tiff|pdf|docx?|pptx?))(?:$|[\s`"])/giu)) {
      const path = match[1];
      if (path) {
        candidates.add(path);
      }
    }
  }

  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existing.push(candidate);
    }
  }

  return existing;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function uniqueKnowledgeEntries(entries: KnowledgeEntryRecord[]): KnowledgeEntryRecord[] {
  const seen = new Set<string>();
  const unique: KnowledgeEntryRecord[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function renderLayeredKnowledgeBlock(entries: KnowledgeEntryRecord[]): string {
  const groups: Array<{ layer: KnowledgeEntryRecord["layer"]; title: string }> = [
    { layer: "working", title: "工作记忆" },
    { layer: "episodic", title: "情景记忆" },
    { layer: "long_term", title: "长期记忆" },
  ];

  const sections = [
    "分层记忆摘要：以下内容来自系统共享知识库，所有角色都应优先参考并保持一致。",
  ];

  for (const group of groups) {
    const items = entries.filter((entry) => entry.layer === group.layer).slice(0, 4);
    if (items.length === 0) {
      continue;
    }

    sections.push("", `${group.title}：`);
    sections.push(
      ...items.map((entry, index) => {
        const tags = entry.tags.length > 0 ? ` [标签: ${entry.tags.join(", ")}]` : "";
        const summary = summarizeText(entry.summary || entry.content, 260);
        return `${index + 1}. (${entry.kind}) ${entry.title}${tags}\n${summary}`;
      }),
    );
  }

  return sections.join("\n");
}

function isKnowledgeEntryUsableForTask(
  entry: KnowledgeEntryRecord,
  task: TaskRecord,
  strictRelevance: boolean,
): boolean {
  if (isPromptPollutedKnowledgeText([entry.title, entry.summary ?? "", entry.content].join("\n"))) {
    return false;
  }

  if (!strictRelevance) {
    return true;
  }

  return isKnowledgeEntryRelevantToInput(entry, task.userInput);
}

function shouldPersistKnowledgeAnswer(task: TaskRecord, answer: string): boolean {
  if (!answer.trim()) {
    return false;
  }

  return !isPromptLeakageOutput(answer, task) && !isPromptPollutedKnowledgeText(answer);
}

function isPromptPollutedKnowledgeText(input: string): boolean {
  return countMarkerHits(input, PROMPT_LEAKAGE_MARKERS) >= 3;
}

function isKnowledgeEntryRelevantToInput(entry: KnowledgeEntryRecord, input: string): boolean {
  const haystack = normalizeKnowledgeLookupText([entry.title, entry.summary ?? "", entry.content, entry.tags.join(" ")].join("\n"));
  if (!haystack) {
    return false;
  }

  const normalizedInput = normalizeKnowledgeLookupText(input);
  if (normalizedInput && haystack.includes(normalizedInput)) {
    return true;
  }

  const compactInput = compactKnowledgeLookupText(input);
  const compactHaystack = compactKnowledgeLookupText([entry.title, entry.summary ?? "", entry.content, entry.tags.join(" ")].join("\n"));
  if (compactInput.length >= 4 && compactHaystack.includes(compactInput)) {
    return true;
  }

  const tokens = tokenizeKnowledgeLookupText(input);
  if (tokens.length === 0) {
    return false;
  }

  let matched = 0;
  for (const token of tokens) {
    if (haystack.includes(token) || compactHaystack.includes(compactKnowledgeLookupText(token))) {
      matched += 1;
    }
  }

  return matched >= Math.min(tokens.length, 2);
}

function normalizeKnowledgeLookupText(input: string): string {
  return normalizeWhitespace(input).toLowerCase();
}

function compactKnowledgeLookupText(input: string): string {
  return normalizeKnowledgeLookupText(input).replace(/[\s\-_/\\]+/gu, "");
}

function tokenizeKnowledgeLookupText(input: string): string[] {
  const tokens = normalizeKnowledgeLookupText(input).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2))];
}

function extractTaskKnowledgeAnswer(task: TaskRecord): string {
  const result = task.result ?? {};
  if (typeof result.answer === "string" && result.answer.trim()) {
    return result.answer;
  }
  if (typeof result.finalPlan === "string" && result.finalPlan.trim()) {
    return result.finalPlan;
  }
  if (typeof task.outputSummary === "string" && task.outputSummary.trim()) {
    return task.outputSummary;
  }
  return "";
}

function buildKnowledgeTags(task: TaskRecord, intent: TaskIntent): string[] {
  const tags = new Set<string>([task.type.toLowerCase(), intent, task.source]);
  const matches = task.normalizedInput.match(/[\p{L}\p{N}_./-]{2,24}/gu) ?? [];
  for (const token of matches.slice(0, 12)) {
    tags.add(token.toLowerCase());
  }
  return [...tags].filter(Boolean).slice(0, 16);
}

function isPreferenceLikeRequest(input: string): boolean {
  return /(记住|记下来|以后|默认|偏好|习惯|优先|固定|长期|总是|不要再|请按这个来)/iu.test(input);
}

function inferKnowledgeLayer(task: TaskRecord, workflow: WorkflowMeta, preference: boolean): KnowledgeEntryRecord["layer"] {
  if (preference) {
    return "long_term";
  }
  if (workflow.intent === "coding" || workflow.intent === "image" || workflow.intent === "doc" || workflow.intent === "ppt") {
    return "working";
  }
  return "episodic";
}

function inferKnowledgeImportance(task: TaskRecord, workflow: WorkflowMeta, preference: boolean): number {
  if (preference) {
    return 95;
  }
  if (workflow.riskLevel === "critical") {
    return 90;
  }
  if (workflow.intent === "coding") {
    return 78;
  }
  if (workflow.artifactType !== "none") {
    return 72;
  }
  return task.type === "SIMPLE" ? 42 : 58;
}

function renderSkillPackPromptBlock(packs: WorkflowMeta["selectedSkillPacks"]): string {
  if (!packs || packs.length === 0) {
    return "";
  }

  return [
    "已装配技能包：",
    ...packs.map((pack) => {
      const toolHints = pack.toolHints.length > 0 ? `；工具侧重：${pack.toolHints.join("、")}` : "";
      const promptHints = pack.promptHints.length > 0 ? `；执行要求：${pack.promptHints.join("；")}` : "";
      return `- ${pack.name}：${pack.description}${toolHints}${promptHints}`;
    }),
  ].join("\n");
}

function matchesApprovalPolicy(
  policy: ApprovalPolicyRecord,
  input: string,
  taskType: TaskType,
  workflow: WorkflowMeta,
  runner: "codex" | "gemini" | null,
): boolean {
  if (!policy.enabled) {
    return false;
  }

  if (policy.matchTaskTypes.length > 0 && !policy.matchTaskTypes.includes(taskType)) {
    return false;
  }
  if (policy.matchIntents.length > 0 && !policy.matchIntents.includes(workflow.intent)) {
    return false;
  }
  if (policy.matchArtifactTypes.length > 0 && !policy.matchArtifactTypes.includes(workflow.artifactType)) {
    return false;
  }
  if (policy.matchRunners.length > 0 && (!runner || !policy.matchRunners.includes(runner))) {
    return false;
  }

  if (policy.matchKeywords.length === 0) {
    return true;
  }

  const normalized = input.toLowerCase();
  return policy.matchKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function inferRequestedRunner(input: string): "codex" | "gemini" | null {
  if (/(gemini\s*cli|调用\s*gemini|用\s*gemini|让\s*gemini|谷歌\s*cli|用\s*谷歌)/iu.test(input)) {
    return "gemini";
  }
  if (/(codex|调用\s*codex|用\s*codex|让\s*codex)/iu.test(input)) {
    return "codex";
  }
  return null;
}

function isImmutableTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "failed"
    || status === "completed"
    || status === "needs_browser_launch"
    || status === "provider_session_lost"
    || status === "needs_manual_login"
    || status === "needs_human_intervention";
}

export class ManualLoginRequiredError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
  }
}

function prioritizeEscalatedAuditTargets(targets: ProviderExecutionTarget[]): ProviderExecutionTarget[] {
  const preferredProviders = new Set(["claude_web", "gemini_web", "chatgpt_web", "grok_web"]);
  return targets.filter((target) => preferredProviders.has(target.provider) || target.preset === "expert" || target.preset === "deep");
}
