import { createHash } from "node:crypto";

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function summarizeText(input: string, maxLength = 400): string {
  const normalized = normalizeWhitespace(input);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 24)}...[truncated ${normalized.length - maxLength + 24} chars]`;
}

export function hashContent(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withBackoff<T>(
  action: () => Promise<T>,
  options?: {
    retries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  const retries = options?.retries ?? 2;
  const initialDelayMs = options?.initialDelayMs ?? 1_000;
  const maxDelayMs = options?.maxDelayMs ?? 10_000;

  let attempt = 0;
  let delay = initialDelayMs;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await action();
    } catch (error) {
      lastError = error;

      if (attempt === retries) {
        throw error;
      }

      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unexpected retry failure.");
}

export function safeJsonParse<T>(input: string | null | undefined, fallback: T): T {
  if (!input) {
    return fallback;
  }

  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function renderTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => params[key] ?? "");
}

export function redactSensitiveText(input: string): string {
  return input
    .replace(/(authorization|token|cookie|session|secret)=([^\s]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

