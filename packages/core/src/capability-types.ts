import type { Json, RetryPolicy } from "./types.ts";

export type CapabilityKind = "tool" | "agent" | "workflow";
export type CapabilitySource = "local" | "mcp" | "a2a";

export type AuthRef =
  | { kind: "none" }
  | { kind: "secret-ref"; name: string }
  | { kind: "headers"; headers: Record<string, string> };

export interface CapabilityExecutionContext {
  runId?: string;
  executionId?: string;
  stepRunId?: string;
  clientRequestId: string;
  abortSignal: AbortSignal;
  timeoutMs?: number | null;
  attempt: number;
}

export interface CapabilityResult<T = unknown> {
  output: T;
  remoteTaskId?: string;
  status: "completed" | "failed" | "cancelled" | "working";
}

export interface CapabilityDescriptor {
  id: string;
  name: string;
  description?: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  provider?: string;
  inputSchema?: Json;
  outputSchema?: Json;
  timeout?: string | number;
  retry?: RetryPolicy;
  auth?: AuthRef;
  endpoint?: string;
}

export interface Capability<TInput = unknown, TOutput = unknown> extends CapabilityDescriptor {
  invoke(input: TInput, context: CapabilityExecutionContext): Promise<CapabilityResult<TOutput>>;
  recover?(context: CapabilityExecutionContext, remoteTaskId: string): Promise<CapabilityResult<TOutput>>;
  cancel?(context: CapabilityExecutionContext, remoteTaskId: string): Promise<void>;
}

export const REMOTE_OPERATION_STATUSES = [
  "PENDING",
  "SENDING",
  "WORKING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type RemoteOperationStatus = (typeof REMOTE_OPERATION_STATUSES)[number];

export interface RemoteOperation {
  id: string;
  runId: string;
  stepRunId: string | null;
  capabilityId: string;
  provider: CapabilitySource | string;
  endpointRef: string;
  remoteTaskId: string | null;
  clientRequestId: string;
  status: RemoteOperationStatus;
  attempt: number;
  protocolVersion: string;
  correlation: Json;
  result: Json | null;
  error: import("./types.ts").PersistedError | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
