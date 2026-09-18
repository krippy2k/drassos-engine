import { parseDuration } from "./duration.ts";
import type { RetryPolicy } from "./types.ts";

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 1,
  backoff: "none",
  initialIntervalMs: 1_000,
  maxIntervalMs: 60_000,
  multiplier: 2,
};

export function normalizeRetry(policy?: RetryPolicy): RetryPolicy {
  const initial =
    policy?.initialIntervalMs ??
    (policy?.initialDelay !== undefined ? parseDuration(policy.initialDelay) : 1_000);
  const max =
    policy?.maxIntervalMs ??
    (policy?.maxDelay !== undefined ? parseDuration(policy.maxDelay) : 60_000);
  return {
    maxAttempts: Math.max(1, policy?.maxAttempts ?? 1),
    backoff: policy?.backoff ?? "none",
    initialIntervalMs: initial,
    maxIntervalMs: max,
    multiplier: policy?.multiplier ?? 2,
  };
}

/**
 * Compute delay before the next attempt.
 * `failedAttempt` is 1-based (1 after the first failure).
 */
export function computeBackoffMs(policy: RetryPolicy, failedAttempt: number): number {
  const normalized = normalizeRetry(policy);
  const initial = normalized.initialIntervalMs ?? 1_000;
  const max = normalized.maxIntervalMs ?? 60_000;
  const multiplier = normalized.multiplier ?? 2;
  if (normalized.backoff === "none" || failedAttempt <= 0) {
    return 0;
  }
  if (normalized.backoff === "fixed") {
    return Math.min(initial, max);
  }
  const ms = initial * multiplier ** (failedAttempt - 1);
  return Math.min(ms, max);
}

export function shouldRetry(policy: RetryPolicy, attempt: number): boolean {
  return attempt < normalizeRetry(policy).maxAttempts;
}
