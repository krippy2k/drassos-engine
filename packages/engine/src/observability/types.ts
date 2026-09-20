import type { Json, PersistedError } from "../core/types.ts";

export const OBSERVABLE_KINDS = [
  "workflow",
  "step",
  "activity",
  "agent",
  "model",
  "tool",
  "mcp",
  "human",
  "child",
  "timer",
  "signal",
] as const;

export type ObservableKind = (typeof OBSERVABLE_KINDS)[number];

export const OBSERVABLE_STATUSES = [
  "scheduled",
  "queued",
  "running",
  "waiting",
  "retrying",
  "completed",
  "failed",
  "cancelled",
  "suspended",
  "timed_out",
] as const;

export type ObservableStatus = (typeof OBSERVABLE_STATUSES)[number];

export type PayloadCapture = "full" | "metadata-only" | "disabled";

export interface ExecutionIdentity {
  workflowId: string;
  runId: string;
  operationId: string;
  parentOperationId?: string;
  traceId?: string;
  spanId?: string;
}

export interface ObservableOperation {
  id: string;
  type: ObservableKind;
  name: string;
  parentId: string | null;
  workflowId: string;
  runId: string;
  status: ObservableStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  attempt: number;
  workerId: string | null;
  input: unknown;
  output: unknown;
  error: PersistedError | { message: string } | Json | null;
  attributes: Record<string, Json | string | number | boolean | null>;
  traceId: string;
  spanId: string;
  children: ObservableOperation[];
}

export interface GraphNode {
  id: string;
  type: ObservableKind;
  name: string;
  status: ObservableStatus;
  runId: string;
  parentId: string | null;
  durationMs: number | null;
  attempt: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface ExecutionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RunListItem {
  id: string;
  workflowName: string;
  workflowVersion: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  currentStep: string | null;
  estimatedCostUsd: number | null;
  error: PersistedError | null;
  parentRunId: string | null;
  forkedFromRunId: string | null;
  forkedFromSeq: number | null;
}

export interface HistoricalSnapshot {
  seq: number;
  timestamp: string | null;
  runStatus: string;
  waitType: string | null;
  completedSteps: Array<{ id: string; name: string; type: string; output: unknown }>;
  pendingSteps: Array<{ id: string; name: string; type: string; status: string }>;
  pendingTimers: Array<{ id: string; fireAt: string; status: string }>;
  pendingHuman: Array<{ id: string; title: string; status: string }>;
  pendingSignals: string[];
  children: Array<{ id: string; workflowName: string; status: string }>;
  agentOutputs: Array<{ id: string; name: string; output: unknown; status: string }>;
}

export interface ObservabilityMetrics {
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  waitingHuman: number;
  successRate: number;
  retryRate: number;
  toolFailureRate: number;
  workflowLatency: Percentiles;
  agentLatency: Percentiles;
  toolLatency: Percentiles;
  tokenInput: number;
  tokenOutput: number;
  estimatedCostUsd: number;
  replayAttempts: number;
  replaySuccesses: number;
  replayDivergences: number;
  replayDuration: Percentiles;
  waitingCompatibleWorkers: number;
  executionsByVersion: Array<{ workflowName: string; version: string; count: number }>;
  workersByVersion: Array<{ version: string; workers: number }>;
}

export interface Percentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface RunQuery {
  workflow?: string;
  status?: string;
  agent?: string;
  worker?: string;
  from?: string;
  to?: string;
  failed?: boolean;
  minDurationMs?: number;
  maxDurationMs?: number;
  limit?: number;
  offset?: number;
}
