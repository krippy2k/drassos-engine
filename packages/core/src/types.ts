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
  "signal",
  "parallel",
  "child",
  "activity",
] as const;

export type StepType = (typeof STEP_TYPES)[number];

export const HUMAN_TASK_STATUSES = ["pending", "completed", "cancelled"] as const;
export type HumanTaskStatus = (typeof HUMAN_TASK_STATUSES)[number];

export const WORK_ITEM_TYPES = [
  "execute_run",
  "fire_timer",
  "activity",
  "agent",
  "tool",
  "mcp-tool",
  "child-workflow-dispatch",
  "custom",
] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const TASK_STATUSES = ["pending", "leased", "completed", "failed", "dead"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DEFAULT_TASK_QUEUE = "default";

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
  "signal.received",
  "signal.wait.started",
  "signal.wait.completed",
  "signal.wait.timed_out",
  "human.interaction.created",
  "human.interaction.completed",
  "human.interaction.timed_out",
  "human.interaction.cancelled",
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
  "execution.created",
  "execution.started",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
  "clock.now",
  "clock.random",
  "clock.uuid",
  "replay.started",
  "replay.completed",
  "replay.divergent",
  "child.created",
  "delegation.requested",
  "delegation.accepted",
  "delegation.rejected",
  "capability.started",
  "capability.completed",
  "capability.failed",
  "capability.cancelled",
  "remote.task.created",
  "remote.task.status",
  "remote.task.recovered",
  "task.leased",
  "task.completed",
  "task.failed",
  "task.retrying",
  "worker.registered",
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
  waitType: "human" | "timer" | "event" | "signal" | "retry" | "join" | "child" | "task" | "compatible-worker" | null;
  waitRef: string | null;
  parentRunId: string | null;
  parentStepId: string | null;
  childDepth: number;
  cancelOnParentCancel: boolean;
  rootRunId: string;
  failurePolicy: ChildFailurePolicy;
  cancellationPolicy: CancellationPolicy;
  timeoutAt: string | null;
  forkedFromRunId: string | null;
  forkedFromSeq: number | null;
  historyFormatVersion: number;
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
  name: string | null;
  queue: string;
  payload: Json;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  priority: number;
  idempotencyKey: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  result: Json | null;
  error: PersistedError | null;
  progress: Json | null;
  availableAt: string;
  startedAt: string | null;
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

export type PayloadCapture = "full" | "metadata-only" | "disabled";

export interface ObservabilityConfig {
  recordPrompts?: boolean;
  recordResponses?: boolean;
  recordToolArguments?: boolean;
  recordToolResults?: boolean;
  payloads?: PayloadCapture;
  workflowInputs?: PayloadCapture;
  workflowOutputs?: PayloadCapture;
  agentInputs?: PayloadCapture;
  agentOutputs?: PayloadCapture;
  modelPrompts?: PayloadCapture;
  modelResponses?: PayloadCapture;
  toolArguments?: PayloadCapture;
  toolResults?: PayloadCapture;
  modelRates?: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
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
  parentAgentRunId: string | null;
  parentExecutionId: string | null;
  rootExecutionId: string;
  depth: number;
  failurePolicy: ChildFailurePolicy;
  cancellationPolicy: CancellationPolicy;
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
  queue?: string;
}

export interface HumanOptions {
  title?: string;
  assignedTo?: string;
  data?: unknown;
}

export const HUMAN_INTERACTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "timed_out",
  "cancelled",
] as const;
export type HumanInteractionStatus = (typeof HUMAN_INTERACTION_STATUSES)[number];

export type HumanDecision<T = unknown> =
  | { outcome: "approved"; data?: T }
  | { outcome: "rejected"; reason?: string }
  | { outcome: "changes_requested"; feedback: string; data?: T }
  | { outcome: "timed_out" };

export interface HumanInteraction {
  id: string;
  runId: string;
  stepRunId: string;
  interactionId: string;
  type: string;
  title: string;
  description: string | null;
  status: HumanInteractionStatus;
  decision: HumanDecision | null;
  metadata: Json | null;
  createdAt: string;
  completedAt: string | null;
}

export interface WorkflowSignal<T = unknown> {
  name: string;
  payload: T;
}

export type SignalWaitResult<T = unknown> =
  | { timedOut: false; payload: T }
  | { timedOut: true };

export interface SignalOptions {
  timeout?: string | number;
}

export interface ApprovalOptions {
  id: string;
  title: string;
  description?: string;
  timeout?: string | number;
  metadata?: Record<string, unknown>;
}

export type ChildFailurePolicy = "fail-parent" | "return-error";
export type CancellationPolicy = "propagate" | "detach";
export type ExecutionType = "workflow" | "agent";
export type ExecutionStatus = WorkflowStatus | "TIMED_OUT";

export interface OrchestrationLimits {
  maxDepth?: number;
  maxChildrenPerExecution?: number;
  maxExecutionsPerTree?: number;
  maxConcurrentChildren?: number;
}

export interface ChildExecutionOptions {
  name?: string;
  retry?: RetryPolicy;
  timeout?: string | number;
  cancellation?: CancellationPolicy;
  onFailure?: ChildFailurePolicy;
  queue?: string;
}

export interface DelegationTask {
  id: string;
  type: ExecutionType;
  target: string;
  input?: unknown;
  dependsOn?: string[];
}

export interface DelegationPlan {
  tasks: DelegationTask[];
}

export interface Execution {
  id: string;
  type: ExecutionType;
  name: string;
  status: ExecutionStatus;
  parentExecutionId: string | null;
  rootExecutionId: string;
  depth: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ExecutionMetadata extends Execution {
  executionId: string;
  originatingStepId?: string | null;
  cancellationPolicy?: CancellationPolicy;
  failurePolicy?: ChildFailurePolicy;
  timeoutAt?: Date | null;
}

export interface ExecutionNode {
  executionId: string;
  type: ExecutionType;
  name: string;
  status: ExecutionStatus;
  children: ExecutionNode[];
}

export interface ExecutionHandle<T = unknown> {
  executionId: string;
  result(): Promise<T>;
  status(): Promise<ExecutionStatus>;
  cancel(): Promise<void>;
}

export const DEFAULT_ORCHESTRATION_LIMITS: Required<OrchestrationLimits> = {
  maxDepth: 8,
  maxChildrenPerExecution: 32,
  maxExecutionsPerTree: 128,
  maxConcurrentChildren: 8,
};

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
