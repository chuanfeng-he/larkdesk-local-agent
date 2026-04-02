import type {
  ArtifactExecutor,
  ArtifactType,
  PromptCatalog,
  ProviderAdapter,
  ProviderConfigFile,
  RoleConfigFile,
  RoutingPolicy,
  SkillConfigFile,
  TaskIntent,
  TaskNotifier,
  TaskType,
} from "@office-agent/core";
import type { FastifyInstance } from "fastify";
import type { AppServices } from "./bootstrap";
import type { AppEnv } from "./env";

type MaybePromise<T> = T | Promise<T>;

export interface ServerApprovalPolicy {
  key: string;
  name: string;
  description?: string;
  enabled?: boolean;
  mode: "auto" | "manual" | "observe";
  priority?: number;
  matchTaskTypes?: TaskType[];
  matchIntents?: TaskIntent[];
  matchArtifactTypes?: ArtifactType[];
  matchRunners?: Array<"codex" | "gemini">;
  matchKeywords?: string[];
}

export interface ServerExtensionSetupContext {
  cwd: string;
  app: FastifyInstance;
  env: AppEnv;
  providerConfig: ProviderConfigFile;
  routingPolicy: RoutingPolicy;
  roleConfig: RoleConfigFile;
  skillConfig: SkillConfigFile;
  prompts: PromptCatalog;
}

export interface ServerExtension {
  name: string;
  createProviders?(context: ServerExtensionSetupContext): MaybePromise<ProviderAdapter[]>;
  createExecutors?(context: ServerExtensionSetupContext): MaybePromise<ArtifactExecutor[]>;
  createNotifiers?(context: ServerExtensionSetupContext): MaybePromise<TaskNotifier[]>;
  approvalPolicies?: ServerApprovalPolicy[];
  onServicesCreated?(services: AppServices): MaybePromise<void>;
  registerRoutes?(app: FastifyInstance, services: AppServices): MaybePromise<void>;
}
