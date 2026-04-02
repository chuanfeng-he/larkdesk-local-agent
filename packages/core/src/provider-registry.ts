import type { TaskStore } from "./contracts";
import type { ProviderAdapter, ProviderHealth } from "./types";

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  constructor(
    providers: ProviderAdapter[],
    private readonly store: TaskStore,
  ) {
    for (const provider of providers) {
      this.providers.set(provider.name, provider);
    }
  }

  get(name: string): ProviderAdapter | undefined {
    return this.providers.get(name);
  }

  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }

  async refreshHealth(): Promise<ProviderHealth[]> {
    const results: ProviderHealth[] = [];

    for (const provider of this.providers.values()) {
      const health = await provider.healthCheck();
      results.push(health);
      await this.store.recordProviderState({
        name: health.provider,
        status: health.status,
        lastError: health.status === "available" ? undefined : health.detail,
        recoveryHint: health.recoveryHint,
        meta: health.meta,
      });
    }

    return results;
  }

  async closeAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.close?.();
    }
  }
}

