import { InvalidSignalError } from "./errors.ts";
import type { HumanDecision } from "./types.ts";

export const HUMAN_SIGNAL_PREFIX = "__human:";

export function humanSignalName(interactionId: string): string {
  return `${HUMAN_SIGNAL_PREFIX}${interactionId}`;
}

export function assertSignalName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new InvalidSignalError("Signal name is required");
  }
  return trimmed;
}

export function parseHumanDecision(value: unknown): HumanDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidSignalError("Human decision must be an object");
  }
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome === "approved") {
    return { outcome: "approved", data: record.data };
  }
  if (outcome === "rejected") {
    return {
      outcome: "rejected",
      reason: typeof record.reason === "string" ? record.reason : undefined,
    };
  }
  if (outcome === "changes_requested") {
    if (typeof record.feedback !== "string" || !record.feedback.trim()) {
      throw new InvalidSignalError("changes_requested requires feedback");
    }
    return { outcome: "changes_requested", feedback: record.feedback, data: record.data };
  }
  if (outcome === "timed_out") {
    return { outcome: "timed_out" };
  }
  throw new InvalidSignalError(`Unknown human decision outcome: ${String(outcome)}`);
}

export function decisionsMatch(left: HumanDecision, right: HumanDecision): boolean {
  if (left.outcome !== right.outcome) {
    return false;
  }
  if (left.outcome === "rejected" && right.outcome === "rejected") {
    return (left.reason ?? "") === (right.reason ?? "");
  }
  if (left.outcome === "changes_requested" && right.outcome === "changes_requested") {
    return left.feedback === right.feedback;
  }
  return true;
}
