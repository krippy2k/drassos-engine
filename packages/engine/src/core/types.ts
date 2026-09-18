export const WORKFLOW_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const STEP_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "RETRYING",
  "CANCELLED",
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_TYPES = [
  "step",
  "agent",
  "human",
  "timer",
  "event",
  "parallel",
  "child",
] as const;

export type StepType = (typeof STEP_TYPES)[number];

export const HUMAN_TASK_STATUSES = ["pending", "completed", "cancelled"] as const;
export type HumanTaskStatus = (typeof HUMAN_TASK_STATUSES)[number];

export const WORK_ITEM_TYPES = ["execute_run", "fire_timer"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const HISTORY_EVENT_TYPES = [
  "workflow.started",
  "workflow.waiting",
  "workflow.resumed",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "step.scheduled",
  "step.started",
  "step.completed",
  "step.failed",
  "step.retrying",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "human.created",
  "human.completed",
  "timer.created",
  "timer.fired",
  "event.received",
  "event.consumed",
  "agent.run.started",
  "agent.turn.started",
  "agent.turn.completed",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.cancelled",
  "model.started",
  "model.completed",
  "model.failed",
  "tool.requested",
  "child.started",
  "child.completed",
  "child.failed",
  "child.cancelled",
] as const;

export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface PersistedError {
  name: string;
  message: string;
  stack?: string;
  type: "user" | "internal";
  attempt?: number;
  operationId?: string;
  timestamp: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersion: string;
  input: Json;
  output: Json | null;
  status: WorkflowStatus;
  error: PersistedError | null;
  cancellation: { reason?: string; cancelledAt: string } | null;
  waitType: "human" | "timer" | "event" | "retry" | "join" | "child" | null;
  waitRef: string | null;
  parentRunId: string | null;
  parentStepId: string | null;
  childDepth: number;
  cancelOnParentCancel: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface StepRun {
  id: string;
  runId: string;
  name: string;
  occurrence: number;
  type: StepType;
  input: Json | null;
  output: Json | null;
  status: StepStatus;
  attempt: number;
  maxAttempts: number;
  error: PersistedError | null;
  timeoutMs: number | null;
  idempotencyKey: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentExecution {
  id: string;
  stepRunId: string;
  runId: string;
  provider: string;
  model: string | null;
  messages: Json | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  durationMs: number | null;
}

export interface ToolInvocation {
  id: string;
  stepRunId: string;
  runId: string;
  name: string;
  input: Json;
  output: Json | null;
  error: PersistedError | null;
  startedAt: string;
  completedAt: string | null;
}

export interface HumanTask {
  id: string;
  runId: string;
  stepRunId: string;
  name: string;
  occurrence: number;
  title: string;
  assignedTo: string | null;
  data: Json;
  response: Json | null;
  status: HumanTaskStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface DurableTimer {
  id: string;
  runId: string;
  stepRunId: string;
  fireAt: string;
  firedAt: string | null;
  status: "pending" | "fired" | "cancelled";
}

export interface ExternalEvent {
  id: string;
  runId: string;
  type: string;
  data: Json;
  receivedAt: string;
  consumedAt: string | null;
  consumedByStepId: string | null;
  deliveryId: string | null;
}

export interface HistoryEvent {
  id: string;
  runId: string;
  seq: number;
  type: HistoryEventType;
  timestamp: string;
  payload: Json;
}

export interface WorkItem {
  id: string;
  runId: string;
  type: WorkItemType;
  payload: Json;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type BackoffKind = "none" | "fixed" | "exponential";

export interface RetryPolicy {
  maxAttempts: number;
  backoff: BackoffKind;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  multiplier?: number;
  initialDelay?: string | number;
  maxDelay?: string | number;
}

export const AGENT_RUN_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_FOR_TOOL",
  "WAITING_FOR_HUMAN",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const TOOL_SOURCES = ["local", "mcp"] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

export interface AgentLimits {
  maxTurns?: number;
  maxToolCalls?: number;
  timeout?: string | number;
}

export interface ObservabilityConfig {
  recordPrompts?: boolean;
  recordResponses?: boolean;
  recordToolArguments?: boolean;
  recordToolResults?: boolean;
}

export interface AgentRunRecord {
  id: string;
  runId: string;
  stepRunId: string;
  agentName: string;
  status: AgentRunStatus;
  currentTurn: number;
  toolCallCount: number;
  modelCallCount: number;
  limits: AgentLimits;
  output: Json | null;
  error: PersistedError | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentTurnRecord {
  id: string;
  agentRunId: string;
  runId: string;
  turnNumber: number;
  inputMessages: Json | null;
  outputMessages: Json | null;
  requestedTools: Json | null;
  startedAt: string;
  completedAt: string | null;
  error: PersistedError | null;
}

export interface ModelCallRecord {
  id: string;
  agentRunId: string;
  agentTurnId: string;
  runId: string;
  provider: string;
  model: string | null;
  request: Json | null;
  response: Json | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  latencyMs: number | null;
  stopReason: string | null;
  attempt: number;
  error: PersistedError | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ToolCallRecord {
  id: string;
  agentRunId: string;
  agentTurnId: string | null;
  runId: string;
  name: string;
  source: ToolSource;
  server: string | null;
  arguments: Json | null;
  result: Json | null;
  status: StepStatus;
  attempt: number;
  idempotencyKey: string | null;
  error: PersistedError | null;
  startedAt: string;
  completedAt: string | null;
}

export interface StepOptions {
  retry?: RetryPolicy;
  timeout?: string | number;
  idempotencyKey?: string;
  input?: Json;
}

export interface HumanOptions {
  title?: string;
  assignedTo?: string;
  data?: unknown;
}

export interface WaitCondition {
  type: "timer" | "human" | "event" | "retry";
  ref: string;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
