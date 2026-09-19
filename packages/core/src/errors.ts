import type { PersistedError } from "./types.ts";

export class DrassosError extends Error {
  readonly code: string;
  readonly isInternal: boolean;

  constructor(
    message: string,
    options?: { code?: string; isInternal?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "DrassosError";
    this.code = options?.code ?? "DRASSOS_ERROR";
    this.isInternal = options?.isInternal ?? true;
  }
}

export class CancellationError extends DrassosError {
  constructor(message = "Workflow run was cancelled") {
    super(message, { code: "CANCELLED", isInternal: true });
    this.name = "CancellationError";
  }
}

export class TimeoutError extends DrassosError {
  constructor(message = "Durable operation timed out") {
    super(message, { code: "TIMEOUT", isInternal: true });
    this.name = "TimeoutError";
  }
}

export class WorkflowNotFoundError extends DrassosError {
  constructor(name: string) {
    super(`Workflow not registered: ${name}`, {
      code: "WORKFLOW_NOT_FOUND",
      isInternal: false,
    });
    this.name = "WorkflowNotFoundError";
  }
}

export class RunNotFoundError extends DrassosError {
  constructor(id: string) {
    super(`Workflow run not found: ${id}`, {
      code: "RUN_NOT_FOUND",
      isInternal: false,
    });
    this.name = "RunNotFoundError";
  }
}

export class HumanTaskNotFoundError extends DrassosError {
  constructor(id: string) {
    super(`Human task not found: ${id}`, {
      code: "HUMAN_TASK_NOT_FOUND",
      isInternal: false,
    });
    this.name = "HumanTaskNotFoundError";
  }
}

export class InvalidTransitionError extends DrassosError {
  constructor(from: string, event: string) {
    super(`Invalid workflow transition from ${from} via ${event}`, {
      code: "INVALID_TRANSITION",
      isInternal: true,
    });
    this.name = "InvalidTransitionError";
  }
}

export class AgentLimitExceededError extends DrassosError {
  readonly limit: "maxTurns" | "maxToolCalls" | "timeout";
  constructor(limit: "maxTurns" | "maxToolCalls" | "timeout", message: string) {
    super(message, { code: "AGENT_LIMIT_EXCEEDED", isInternal: false });
    this.name = "AgentLimitExceededError";
    this.limit = limit;
  }
}

export class AgentTimeoutError extends DrassosError {
  readonly limit = "timeout" as const;
  constructor(message = "Agent execution timed out") {
    super(message, { code: "AGENT_TIMEOUT", isInternal: false });
    this.name = "AgentTimeoutError";
  }
}

export class ModelProviderError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "MODEL_PROVIDER_ERROR", isInternal: false, cause });
    this.name = "ModelProviderError";
  }
}

export class ToolExecutionError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "TOOL_EXECUTION_ERROR", isInternal: false, cause });
    this.name = "ToolExecutionError";
  }
}

export class UnknownToolError extends DrassosError {
  constructor(name: string) {
    super(`Unknown tool: ${name}`, { code: "UNKNOWN_TOOL", isInternal: false });
    this.name = "UnknownToolError";
  }
}

export class UnauthorizedToolError extends DrassosError {
  constructor(name: string) {
    super(`Agent is not authorized to call tool: ${name}`, {
      code: "UNAUTHORIZED_TOOL",
      isInternal: false,
    });
    this.name = "UnauthorizedToolError";
  }
}

export class InvalidToolRequestError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "INVALID_TOOL_REQUEST", isInternal: false });
    this.name = "InvalidToolRequestError";
  }
}

export class ToolInputValidationError extends DrassosError {
  readonly toolName: string;
  constructor(toolName: string, message: string) {
    super(`Invalid arguments for tool ${toolName}: ${message}`, {
      code: "TOOL_INPUT_VALIDATION",
      isInternal: false,
    });
    this.name = "ToolInputValidationError";
    this.toolName = toolName;
  }
}

export class ToolOutputValidationError extends DrassosError {
  readonly toolName: string;
  constructor(toolName: string, message: string) {
    super(`Invalid result from tool ${toolName}: ${message}`, {
      code: "TOOL_OUTPUT_VALIDATION",
      isInternal: false,
    });
    this.name = "ToolOutputValidationError";
    this.toolName = toolName;
  }
}

export class StructuredOutputError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "STRUCTURED_OUTPUT_VALIDATION", isInternal: false });
    this.name = "StructuredOutputError";
  }
}

export class ModelTimeoutError extends DrassosError {
  constructor(message = "Model provider request timed out") {
    super(message, { code: "MODEL_TIMEOUT", isInternal: false });
    this.name = "ModelTimeoutError";
  }
}

export class McpConnectionError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "MCP_CONNECTION_ERROR", isInternal: false, cause });
    this.name = "McpConnectionError";
  }
}

export class McpProtocolError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "MCP_PROTOCOL_ERROR", isInternal: false, cause });
    this.name = "McpProtocolError";
  }
}

export class McpAuthError extends DrassosError {
  constructor(message = "MCP authentication failed") {
    super(message, { code: "MCP_AUTH_ERROR", isInternal: false });
    this.name = "McpAuthError";
  }
}

export class McpUnknownToolError extends DrassosError {
  constructor(name: string) {
    super(`Unknown MCP tool: ${name}`, { code: "MCP_UNKNOWN_TOOL", isInternal: false });
    this.name = "McpUnknownToolError";
  }
}

export class McpRemoteError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "MCP_REMOTE_ERROR", isInternal: false, cause });
    this.name = "McpRemoteError";
  }
}

export class A2AConnectionError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "A2A_CONNECTION_ERROR", isInternal: false, cause });
    this.name = "A2AConnectionError";
  }
}

export class A2AProtocolError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "A2A_PROTOCOL_ERROR", isInternal: false, cause });
    this.name = "A2AProtocolError";
  }
}

export class A2AAuthError extends DrassosError {
  constructor(message = "A2A authentication failed") {
    super(message, { code: "A2A_AUTH_ERROR", isInternal: false });
    this.name = "A2AAuthError";
  }
}

export class A2ARemoteError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "A2A_REMOTE_ERROR", isInternal: false, cause });
    this.name = "A2ARemoteError";
  }
}

export class CapabilityNotFoundError extends DrassosError {
  constructor(id: string) {
    super(`Capability not found: ${id}`, { code: "CAPABILITY_NOT_FOUND", isInternal: false });
    this.name = "CapabilityNotFoundError";
  }
}

export class RemoteCancelFailedError extends DrassosError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "REMOTE_CANCEL_FAILED", isInternal: false, cause });
    this.name = "RemoteCancelFailedError";
  }
}

export class ChildWorkflowError extends DrassosError {
  readonly childRunId: string;
  constructor(childRunId: string, message: string, cause?: unknown) {
    super(message, { code: "CHILD_WORKFLOW_ERROR", isInternal: false, cause });
    this.name = "ChildWorkflowError";
    this.childRunId = childRunId;
  }
}

export class ChildExecutionFailedError extends DrassosError {
  readonly childExecutionId: string;
  constructor(childExecutionId: string, message: string, cause?: unknown) {
    super(message, { code: "CHILD_EXECUTION_FAILED", isInternal: false, cause });
    this.name = "ChildExecutionFailedError";
    this.childExecutionId = childExecutionId;
  }
}

export class ChildExecutionTimeoutError extends DrassosError {
  readonly childExecutionId: string;
  constructor(childExecutionId: string, message = `Child execution ${childExecutionId} timed out`) {
    super(message, { code: "CHILD_EXECUTION_TIMEOUT", isInternal: false });
    this.name = "ChildExecutionTimeoutError";
    this.childExecutionId = childExecutionId;
  }
}

export class ChildExecutionCancelledError extends DrassosError {
  readonly childExecutionId: string;
  constructor(childExecutionId: string, message = `Child execution ${childExecutionId} was cancelled`) {
    super(message, { code: "CHILD_EXECUTION_CANCELLED", isInternal: false });
    this.name = "ChildExecutionCancelledError";
    this.childExecutionId = childExecutionId;
  }
}

export class UnknownAgentError extends DrassosError {
  constructor(name: string) {
    super(`Unknown agent: ${name}`, { code: "UNKNOWN_AGENT", isInternal: false });
    this.name = "UnknownAgentError";
  }
}

export class UnknownWorkflowError extends DrassosError {
  constructor(name: string) {
    super(`Unknown workflow: ${name}`, { code: "UNKNOWN_WORKFLOW", isInternal: false });
    this.name = "UnknownWorkflowError";
  }
}

export class InvalidDelegationPlanError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "INVALID_DELEGATION_PLAN", isInternal: false });
    this.name = "InvalidDelegationPlanError";
  }
}

export class CircularDependencyError extends DrassosError {
  constructor(message = "Delegation plan contains a cycle") {
    super(message, { code: "CIRCULAR_DEPENDENCY", isInternal: false });
    this.name = "CircularDependencyError";
  }
}

export class ExecutionDepthExceededError extends DrassosError {
  readonly depth: number;
  readonly maxDepth: number;
  constructor(depth: number, maxDepth: number) {
    super(`Execution depth ${depth} exceeded maximum ${maxDepth}`, {
      code: "EXECUTION_DEPTH_EXCEEDED",
      isInternal: false,
    });
    this.name = "ExecutionDepthExceededError";
    this.depth = depth;
    this.maxDepth = maxDepth;
  }
}

export class ExecutionLimitExceededError extends DrassosError {
  readonly limit: string;
  constructor(limit: string, message: string) {
    super(message, { code: "EXECUTION_LIMIT_EXCEEDED", isInternal: false });
    this.name = "ExecutionLimitExceededError";
    this.limit = limit;
  }
}

export class UnserializableValueError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "UNSERIALIZABLE_VALUE", isInternal: false });
    this.name = "UnserializableValueError";
  }
}

export class WorkflowVersionError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "WORKFLOW_VERSION_ERROR", isInternal: false });
    this.name = "WorkflowVersionError";
  }
}

export class InvalidSignalError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "INVALID_SIGNAL", isInternal: false });
    this.name = "InvalidSignalError";
  }
}

export class SignalNotAllowedError extends DrassosError {
  constructor(runId: string, status: string) {
    super(`Cannot signal workflow ${runId} in status ${status}`, {
      code: "SIGNAL_NOT_ALLOWED",
      isInternal: false,
    });
    this.name = "SignalNotAllowedError";
  }
}

export class InteractionNotFoundError extends DrassosError {
  constructor(runId: string, interactionId: string) {
    super(`Human interaction ${interactionId} not found on workflow ${runId}`, {
      code: "INTERACTION_NOT_FOUND",
      isInternal: false,
    });
    this.name = "InteractionNotFoundError";
  }
}

export class InteractionAlreadyCompletedError extends DrassosError {
  constructor(interactionId: string) {
    super(`Human interaction ${interactionId} is already completed`, {
      code: "INTERACTION_ALREADY_COMPLETED",
      isInternal: false,
    });
    this.name = "InteractionAlreadyCompletedError";
  }
}

export class StaleLeaseError extends DrassosError {
  constructor(taskId: string) {
    super(`Lease token is invalid or expired for task ${taskId}`, {
      code: "STALE_LEASE",
      isInternal: false,
    });
    this.name = "StaleLeaseError";
  }
}

export class UnknownActivityError extends DrassosError {
  constructor(name: string) {
    super(`Unknown activity: ${name}`, { code: "UNKNOWN_ACTIVITY", isInternal: false });
    this.name = "UnknownActivityError";
  }
}

export class IncompatibleWorkerProtocolError extends DrassosError {
  constructor(version: string) {
    super(`Incompatible worker protocol version "${version}". Expected 1.`, {
      code: "INCOMPATIBLE_WORKER_PROTOCOL",
      isInternal: false,
    });
    this.name = "IncompatibleWorkerProtocolError";
  }
}

export class WorkerAuthError extends DrassosError {
  constructor(message = "Worker authentication failed") {
    super(message, { code: "WORKER_AUTH_ERROR", isInternal: false });
    this.name = "WorkerAuthError";
  }
}

export class TaskPayloadTooLargeError extends DrassosError {
  constructor(bytes: number) {
    super(`Task payload exceeds limit (${bytes} bytes)`, {
      code: "TASK_PAYLOAD_TOO_LARGE",
      isInternal: false,
    });
    this.name = "TaskPayloadTooLargeError";
  }
}

export const DIVERGENCE_KINDS = [
  "OPERATION_CHANGED",
  "OPERATION_ADDED",
  "OPERATION_REMOVED",
  "ORDER_CHANGED",
  "INPUT_CHANGED",
  "BRANCH_CHANGED",
  "MISSING_HANDLER",
  "INCOMPATIBLE_STATE",
  "UNKNOWN",
] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

export interface ReplayDivergence {
  kind: DivergenceKind;
  executionId: string;
  workflowName: string;
  recordedVersion: string;
  testedVersion: string;
  historySequence: number | null;
  expected: string;
  actual: string;
  reason: string;
  source?: string;
}

export class WorkflowRegistrationError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "WORKFLOW_REGISTRATION_ERROR", isInternal: false });
    this.name = "WorkflowRegistrationError";
  }
}

export class CompatibleWorkerMissing extends DrassosError {
  constructor(workflowName: string, version: string) {
    super(`No compatible worker for ${workflowName}@${version}`, {
      code: "COMPATIBLE_WORKER_MISSING",
      isInternal: true,
    });
    this.name = "CompatibleWorkerMissing";
  }
}

export class UnsupportedHistoryFormatError extends DrassosError {
  constructor(formatVersion: number) {
    super(`Unsupported history format version ${formatVersion}`, {
      code: "UNSUPPORTED_HISTORY_FORMAT",
      isInternal: false,
    });
    this.name = "UnsupportedHistoryFormatError";
  }
}

export class ReplayDivergenceError extends DrassosError {
  readonly divergence: ReplayDivergence;
  constructor(divergence: ReplayDivergence) {
    super(
      [
        "ReplayDivergenceError",
        `Execution: ${divergence.executionId}`,
        `Workflow: ${divergence.workflowName}`,
        `Recorded version: ${divergence.recordedVersion}`,
        `Tested version: ${divergence.testedVersion}`,
        divergence.historySequence != null ? `History sequence: ${divergence.historySequence}` : null,
        `Expected: ${divergence.expected}`,
        `Actual: ${divergence.actual}`,
        divergence.source ? `Source: ${divergence.source}` : null,
        divergence.reason,
      ]
        .filter(Boolean)
        .join("\n"),
      { code: "REPLAY_DIVERGENCE", isInternal: false },
    );
    this.name = "ReplayDivergenceError";
    this.divergence = divergence;
  }
}

export interface WaitDescriptor {
  type: "timer" | "human" | "event" | "signal" | "retry" | "join" | "child" | "task";
  ref: string;
}

export class WorkflowSuspend extends Error {
  readonly waits: WaitDescriptor[];

  constructor(waits: WaitDescriptor[] | WaitDescriptor) {
    super("WORKFLOW_SUSPEND");
    this.name = "WorkflowSuspend";
    this.waits = Array.isArray(waits) ? waits : [waits];
  }
}

export function serializeError(
  error: unknown,
  extras?: { attempt?: number; operationId?: string },
): PersistedError {
  if (error instanceof DrassosError) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      type: error.isInternal ? "internal" : "user",
      attempt: extras?.attempt,
      operationId: extras?.operationId,
      timestamp: new Date().toISOString(),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      type: "user",
      attempt: extras?.attempt,
      operationId: extras?.operationId,
      timestamp: new Date().toISOString(),
    };
  }
  return {
    name: "UnknownError",
    message: String(error),
    type: "user",
    attempt: extras?.attempt,
    operationId: extras?.operationId,
    timestamp: new Date().toISOString(),
  };
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
