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

export class ChildWorkflowError extends DrassosError {
  readonly childRunId: string;
  constructor(childRunId: string, message: string, cause?: unknown) {
    super(message, { code: "CHILD_WORKFLOW_ERROR", isInternal: false, cause });
    this.name = "ChildWorkflowError";
    this.childRunId = childRunId;
  }
}

export class WorkflowVersionError extends DrassosError {
  constructor(message: string) {
    super(message, { code: "WORKFLOW_VERSION_ERROR", isInternal: false });
    this.name = "WorkflowVersionError";
  }
}

export interface WaitDescriptor {
  type: "timer" | "human" | "event" | "retry" | "join" | "child";
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
