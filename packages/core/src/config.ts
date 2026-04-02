import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import type { PromptCatalog, ProviderConfigFile, RoleConfigFile, RoutingPolicy, SkillConfigFile } from "./types";

export async function loadProviderConfig(configDir: string): Promise<ProviderConfigFile> {
  const filePath = resolve(configDir, "providers.yaml");
  const content = await readFile(filePath, "utf8");
  return YAML.parse(content) as ProviderConfigFile;
}

export async function loadRoutingPolicy(configDir: string): Promise<RoutingPolicy> {
  const filePath = resolve(configDir, "routing-policy.yaml");
  const content = await readFile(filePath, "utf8");
  return YAML.parse(content) as RoutingPolicy;
}

export async function loadRoleConfig(configDir: string): Promise<RoleConfigFile> {
  const filePath = resolve(configDir, "roles.yaml");
  const content = await readFile(filePath, "utf8");
  return YAML.parse(content) as RoleConfigFile;
}

export async function loadSkillConfig(configDir: string): Promise<SkillConfigFile> {
  const filePath = resolve(configDir, "skills.yaml");
  const content = await readFile(filePath, "utf8");
  return YAML.parse(content) as SkillConfigFile;
}

export async function loadPromptCatalog(configDir: string): Promise<PromptCatalog> {
  const promptsDir = resolve(configDir, "prompts");
  const [classification, drafting, review, arbitration, codexHandoff] = await Promise.all([
    readFile(resolve(promptsDir, "classification.md"), "utf8"),
    readFile(resolve(promptsDir, "drafting.md"), "utf8"),
    readFile(resolve(promptsDir, "review.md"), "utf8"),
    readFile(resolve(promptsDir, "arbitration.md"), "utf8"),
    readFile(resolve(promptsDir, "codex-handoff.md"), "utf8"),
  ]);

  return {
    classification,
    drafting,
    review,
    arbitration,
    codexHandoff,
  };
}
