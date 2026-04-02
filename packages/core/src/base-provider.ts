import PQueue from "p-queue";
import type {
  ProviderAdapter,
  ProviderCompletion,
  ProviderHealth,
  ProviderPromptRequest,
  ProviderRunHandle,
  ProviderRuntimeConfig,
  SessionState,
} from "./types";
import { summarizeText, withBackoff } from "./utils";

export abstract class AbstractProviderAdapter implements ProviderAdapter {
  readonly queue: PQueue;

  abstract readonly kind: "mock" | "web" | "scaffold" | "api" | "copilot";

  constructor(
    public readonly name: string,
    protected readonly config: ProviderRuntimeConfig,
  ) {
    this.queue = new PQueue({
      concurrency: Math.max(1, config.maxConcurrency),
      interval: 60_000,
      intervalCap: Math.max(1, config.rateLimitPerMinute),
    });
  }

  getConfig(): ProviderRuntimeConfig {
    return this.config;
  }

  abstract healthCheck(): Promise<ProviderHealth>;

  abstract ensureSession(): Promise<SessionState>;

  async applyPreset(_request: ProviderPromptRequest): Promise<void> {}

  abstract sendPrompt(request: ProviderPromptRequest): Promise<ProviderRunHandle>;

  abstract waitForCompletion(handle: ProviderRunHandle): Promise<ProviderCompletion>;

  abstract extractAnswer(completion: ProviderCompletion): Promise<{
    provider: string;
    outputText: string;
    summary: string;
    rawOutput?: string;
    screenshotPath?: string;
    requiresManualLogin?: boolean;
    meta?: Record<string, unknown>;
  }>;

  async screenshotOnFailure(_taskId: string, _error: Error): Promise<string | undefined> {
    return undefined;
  }

  abstract manualRecoveryHint(): string;

  protected schedule<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn) as Promise<T>;
  }

  protected runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withBackoff(fn, {
      retries: 2,
      initialDelayMs: 1_000,
      maxDelayMs: 6_000,
    });
  }

  protected summarize(input: string): string {
    return summarizeText(input, 300);
  }
}
