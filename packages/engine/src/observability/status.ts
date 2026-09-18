import type { ObservableStatus } from "./types.ts";

export function mapEngineStatus(status: string | null | undefined): ObservableStatus {
  switch (status) {
    case "PENDING":
    case "pending":
      return "scheduled";
    case "queued":
    case "leased":
      return "queued";
    case "RUNNING":
    case "running":
    case "WORKING":
      return "running";
    case "WAITING":
    case "WAITING_FOR_TOOL":
    case "WAITING_FOR_HUMAN":
    case "waiting":
    case "suspended":
      return status === "WAITING" || status === "waiting" || status === "WAITING_FOR_TOOL" || status === "WAITING_FOR_HUMAN"
        ? "waiting"
        : "waiting";
    case "RETRYING":
    case "retrying":
      return "retrying";
    case "COMPLETED":
    case "completed":
    case "fired":
      return "completed";
    case "FAILED":
    case "failed":
    case "dead":
      return "failed";
    case "CANCELLED":
    case "cancelled":
      return "cancelled";
    case "TIMED_OUT":
    case "timed_out":
      return "timed_out";
    default:
      return "running";
  }
}

export function durationMs(start?: string | null, end?: string | null, now = Date.now()): number | null {
  if (!start) {
    return null;
  }
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return Math.max(0, to - from);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function percentiles(values: number[]): { p50: number | null; p95: number | null; p99: number | null } {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}
