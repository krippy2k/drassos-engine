import { InvalidTransitionError } from "./errors.ts";
import type { WorkflowStatus } from "./types.ts";

export type RunTransitionEvent =
  | "start"
  | "wait"
  | "resume"
  | "complete"
  | "fail"
  | "cancel";

const TRANSITIONS: Record<WorkflowStatus, Partial<Record<RunTransitionEvent, WorkflowStatus>>> = {
  PENDING: {
    start: "RUNNING",
    cancel: "CANCELLED",
  },
  RUNNING: {
    wait: "WAITING",
    complete: "COMPLETED",
    fail: "FAILED",
    cancel: "CANCELLED",
  },
  WAITING: {
    resume: "RUNNING",
    cancel: "CANCELLED",
    fail: "FAILED",
  },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
};

export function isTerminalStatus(status: WorkflowStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

export function canTransition(from: WorkflowStatus, event: RunTransitionEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function transitionRun(from: WorkflowStatus, event: RunTransitionEvent): WorkflowStatus {
  const next = TRANSITIONS[from][event];
  if (!next) {
    throw new InvalidTransitionError(from, event);
  }
  return next;
}
