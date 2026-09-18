import type { Json, PersistedError, WorkItemType } from "../core/types.ts";

export const WORKER_PROTOCOL_VERSION = "1";
export const MAX_TASK_PAYLOAD_BYTES = 1_048_576;
export const DEFAULT_WORKER_LEASE_MS = 30_000;

export const DISTRIBUTED_TASK_TYPES: WorkItemType[] = [
  "activity",
  "agent",
  "tool",
  "mcp-tool",
  "child-workflow-dispatch",
  "custom",
];

export function isDistributedTaskType(type: string): boolean {
  return (DISTRIBUTED_TASK_TYPES as string[]).includes(type);
}

export interface WorkerRegisterRequest {
  protocolVersion?: string;
  workerId: string;
  queues: string[];
  concurrency: number;
  capabilities?: string[];
  version?: string;
  hostname?: string;
  processId?: number;
  workflowVersions?: string[];
}

export interface WorkerHeartbeatRequest {
  protocolVersion?: string;
  workerId: string;
  availableSlots?: number;
  activeTasks?: number;
  status?: "online" | "draining" | "offline";
}

export interface WorkerPollRequest {
  protocolVersion?: string;
  workerId: string;
  queues: string[];
  availableSlots: number;
  waitMs?: number;
}

export interface WorkerTaskView {
  id: string;
  type: string;
  name: string | null;
  queue: string;
  workflowRunId: string;
  payload: Json;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface WorkerPollResponse {
  protocolVersion: string;
  tasks: WorkerTaskView[];
}

export interface TaskHeartbeatRequest {
  protocolVersion?: string;
  workerId: string;
  leaseToken: string;
  progress?: Json;
}

export interface TaskCompleteRequest {
  protocolVersion?: string;
  workerId: string;
  leaseToken: string;
  result?: Json;
}

export interface TaskFailRequest {
  protocolVersion?: string;
  workerId: string;
  leaseToken: string;
  error: {
    type?: string;
    name?: string;
    message: string;
    retryable?: boolean;
  };
}

export interface TaskAckResponse {
  protocolVersion: string;
  ok: true;
  duplicate?: boolean;
  status: string;
}

export interface WorkerDrainRequest {
  protocolVersion?: string;
  workerId: string;
}

export interface ActivityContext {
  readonly taskId: string;
  readonly workflowRunId: string;
  readonly runId: string;
  readonly queue: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly abortSignal: AbortSignal;
  heartbeat(progress?: Json): Promise<void>;
}

export type ActivityHandler = (ctx: ActivityContext, input: unknown) => Promise<unknown> | unknown;
export type AgentHandler = (ctx: ActivityContext, input: unknown) => Promise<unknown> | unknown;

export function payloadSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

export function toPersistedWorkerError(error: {
  type?: string;
  name?: string;
  message: string;
}): PersistedError {
  return {
    name: error.name ?? error.type ?? "Error",
    message: error.message,
    type: "user",
    timestamp: new Date().toISOString(),
  };
}
