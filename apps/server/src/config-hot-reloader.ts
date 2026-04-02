import { watch, type FSWatcher } from "node:fs";
import { basename, resolve } from "node:path";
import { loadRoleConfig, loadSkillConfig, type MonitorHub, type RoleRegistry, type SkillRegistry } from "@office-agent/core";

function debounce(fn: () => void, delayMs: number): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, delayMs);
  };
}

export class ConfigHotReloader {
  private readonly watchers: FSWatcher[] = [];
  private closed = false;

  constructor(
    private readonly configDir: string,
    private readonly roleRegistry: RoleRegistry,
    private readonly skillRegistry: SkillRegistry,
    private readonly monitor: MonitorHub,
    private readonly logger: {
      info(input: Record<string, unknown>, message: string): void;
      error(input: Record<string, unknown>, message: string): void;
    },
  ) {}

  start(): void {
    const targets = [
      {
        filePath: resolve(this.configDir, "roles.yaml"),
        onReload: debounce(() => {
          void this.reloadRoles();
        }, 150),
      },
      {
        filePath: resolve(this.configDir, "skills.yaml"),
        onReload: debounce(() => {
          void this.reloadSkills();
        }, 150),
      },
    ];

    for (const target of targets) {
      const watcher = watch(target.filePath, () => {
        if (this.closed) {
          return;
        }
        target.onReload();
      });
      this.watchers.push(watcher);
    }
  }

  close(): void {
    this.closed = true;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;
  }

  private async reloadRoles(): Promise<void> {
    const filePath = resolve(this.configDir, "roles.yaml");
    try {
      const config = await loadRoleConfig(this.configDir);
      this.roleRegistry.replaceAll(config.roles);
      this.logger.info(
        {
          configFile: basename(filePath),
          roleCount: config.roles.length,
        },
        "Role registry hot reloaded",
      );
      this.monitor.emit({
        type: "config.reloaded",
        detail: `roles.yaml -> ${config.roles.length} roles`,
        meta: {
          configFile: "roles.yaml",
          count: config.roles.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          configFile: basename(filePath),
          err: message,
        },
        "Role registry hot reload failed",
      );
      this.monitor.emit({
        type: "config.reload_failed",
        detail: `roles.yaml -> ${message}`,
        meta: {
          configFile: "roles.yaml",
        },
      });
    }
  }

  private async reloadSkills(): Promise<void> {
    const filePath = resolve(this.configDir, "skills.yaml");
    try {
      const config = await loadSkillConfig(this.configDir);
      this.skillRegistry.replaceAll(config.skills);
      this.logger.info(
        {
          configFile: basename(filePath),
          skillCount: config.skills.length,
        },
        "Skill registry hot reloaded",
      );
      this.monitor.emit({
        type: "config.reloaded",
        detail: `skills.yaml -> ${config.skills.length} skills`,
        meta: {
          configFile: "skills.yaml",
          count: config.skills.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          configFile: basename(filePath),
          err: message,
        },
        "Skill registry hot reload failed",
      );
      this.monitor.emit({
        type: "config.reload_failed",
        detail: `skills.yaml -> ${message}`,
        meta: {
          configFile: "skills.yaml",
        },
      });
    }
  }
}
