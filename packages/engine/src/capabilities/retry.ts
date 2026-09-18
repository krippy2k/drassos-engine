import {
  A2AAuthError,
  A2AConnectionError,
  A2AProtocolError,
  A2ARemoteError,
  CancellationError,
  McpAuthError,
  McpConnectionError,
  McpRemoteError,
  McpUnknownToolError,
  TimeoutError,
} from "../core/errors.ts";

export function isPermanentInteropError(error: unknown): boolean {
  return (
    error instanceof McpAuthError ||
    error instanceof A2AAuthError ||
    error instanceof A2AProtocolError ||
    error instanceof A2ARemoteError ||
    error instanceof McpRemoteError ||
    error instanceof McpUnknownToolError ||
    error instanceof CancellationError
  );
}

export function isTransientInteropError(error: unknown): boolean {
  if (
    error instanceof McpConnectionError ||
    error instanceof A2AConnectionError ||
    error instanceof TimeoutError
  ) {
    return true;
  }
  if (error instanceof McpAuthError || error instanceof A2AAuthError || error instanceof A2AProtocolError) {
    return false;
  }
  if (error instanceof CancellationError) {
    return false;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("econnreset") || message.includes("etimedout") || message.includes("unavailable");
  }
  return false;
}
