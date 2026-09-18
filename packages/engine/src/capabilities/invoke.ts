import {
  CancellationError,
  RemoteCancelFailedError,
  TimeoutError,
  WorkflowSuspend,
  serializeError,
} from "../core/errors.ts";
import { toJson } from "../core/serialize.ts";
import type { Store } from "../persistence/store.ts";
import type { Logger } from "../runtime/logger.ts";
import type { WorkNotifier } from "../runtime/notifier.ts";
import { sanitizeAuth } from "./auth.ts";
import type { Capability, CapabilityResult, RemoteOperation } from "./types.ts";

export interface ExecuteRemoteCapabilityOptions {
  store: Store;
  runId: string;
  stepRunId: string | null;
  capability: Capability;
  input: unknown;
  abortSignal: AbortSignal;
  timeoutMs?: number | null;
  attempt?: number;
  logger?: Logger;
  notifier?: WorkNotifier;
  pollMs?: number;
}

export async function executeRemoteCapability(options: ExecuteRemoteCapabilityOptions): Promise<unknown> {
  const clientRequestId = `${options.runId}:${options.stepRunId ?? "nostep"}:${options.capability.id}`;
  const existing = await options.store.getRemoteOperationByRequest(options.runId, clientRequestId);
  const operation =
    existing ??
    (await options.store.insertRemoteOperation({
      runId: options.runId,
      stepRunId: options.stepRunId,
      capabilityId: options.capability.id,
      provider: options.capability.source,
      endpointRef: options.capability.endpoint ?? options.capability.provider ?? options.capability.source,
      clientRequestId,
      status: "PENDING",
      attempt: options.attempt ?? 1,
      protocolVersion: "1",
      correlation: {
        capability: options.capability.id,
        kind: options.capability.kind,
        auth: sanitizeAuth(options.capability.auth) ?? null,
      },
    }));

  if (!existing) {
    await options.store.appendHistory({
      runId: options.runId,
      type: "capability.started",
      payload: {
        capabilityId: options.capability.id,
        source: options.capability.source,
        provider: options.capability.provider ?? null,
        clientRequestId,
      },
    });
  }

  if (operation.status === "COMPLETED") {
    return operation.result;
  }
  if (operation.status === "FAILED") {
    const error = new Error(operation.error?.message ?? "Remote capability failed");
    error.name = operation.error?.name ?? "Error";
    throw error;
  }
  if (operation.status === "CANCELLED") {
    throw new CancellationError();
  }

  const context = {
    runId: options.runId,
    executionId: options.runId,
    stepRunId: options.stepRunId ?? undefined,
    clientRequestId,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    attempt: options.attempt ?? operation.attempt,
  };

  if (operation.remoteTaskId && (operation.status === "WORKING" || operation.status === "SENDING")) {
    await options.store.appendHistory({
      runId: options.runId,
      type: "remote.task.recovered",
      payload: {
        capabilityId: options.capability.id,
        remoteTaskId: operation.remoteTaskId,
        clientRequestId,
      },
    });
    return finishRemoteResult(
      options,
      operation,
      await recoverOnce(options, operation, context, operation.remoteTaskId),
    );
  }

  await options.store.updateRemoteOperation(operation.id, { status: "SENDING", attempt: context.attempt });
  try {
    const result = await withInvokeTimeout(
      () => options.capability.invoke(options.input, context),
      options.timeoutMs ?? null,
      options.abortSignal,
    );
    return finishRemoteResult(options, operation, result);
  } catch (error) {
    if (error instanceof WorkflowSuspend) {
      throw error;
    }
    if (options.abortSignal.aborted) {
      await cancelRemote(options, operation);
      throw new CancellationError();
    }
    await failRemote(options, operation, error);
    throw error;
  }
}

async function finishRemoteResult(
  options: ExecuteRemoteCapabilityOptions,
  operation: RemoteOperation,
  result: CapabilityResult,
): Promise<unknown> {
  if (result.remoteTaskId && result.remoteTaskId !== operation.remoteTaskId) {
    await options.store.updateRemoteOperation(operation.id, {
      remoteTaskId: result.remoteTaskId,
      status: result.status === "working" ? "WORKING" : operation.status,
    });
    await options.store.appendHistory({
      runId: options.runId,
      type: "remote.task.created",
      payload: {
        capabilityId: options.capability.id,
        remoteTaskId: result.remoteTaskId,
        clientRequestId: operation.clientRequestId,
      },
    });
  }
  if (result.status === "working") {
    if (!result.remoteTaskId && !operation.remoteTaskId) {
      throw new Error(`Capability ${options.capability.id} returned working without a remote task id`);
    }
    const remoteTaskId = result.remoteTaskId ?? operation.remoteTaskId!;
    await options.store.updateRemoteOperation(operation.id, { status: "WORKING", remoteTaskId });
    await yieldRemotePoll(options, remoteTaskId);
  }
  if (result.status === "cancelled") {
    await options.store.updateRemoteOperation(operation.id, {
      status: "CANCELLED",
      completedAt: new Date().toISOString(),
    });
    await options.store.appendHistory({
      runId: options.runId,
      type: "capability.cancelled",
      payload: { capabilityId: options.capability.id, clientRequestId: operation.clientRequestId },
    });
    throw new CancellationError();
  }
  if (result.status === "failed") {
    const error = new Error(`Capability ${options.capability.id} failed`);
    await failRemote(options, operation, error);
    throw error;
  }
  const output = toJson(result.output);
  await options.store.updateRemoteOperation(operation.id, {
    status: "COMPLETED",
    result: output,
    remoteTaskId: result.remoteTaskId ?? operation.remoteTaskId,
    completedAt: new Date().toISOString(),
  });
  await options.store.appendHistory({
    runId: options.runId,
    type: "capability.completed",
    payload: {
      capabilityId: options.capability.id,
      source: options.capability.source,
      remoteTaskId: result.remoteTaskId ?? operation.remoteTaskId,
    },
  });
  return result.output;
}

async function recoverOnce(
  options: ExecuteRemoteCapabilityOptions,
  operation: RemoteOperation,
  context: Parameters<NonNullable<Capability["recover"]>>[0],
  remoteTaskId: string,
): Promise<CapabilityResult> {
  if (!options.capability.recover) {
    throw new Error(`Capability ${options.capability.id} cannot recover remote task ${remoteTaskId}`);
  }
  if (options.abortSignal.aborted) {
    await cancelRemote(options, operation);
    throw new CancellationError();
  }
  const elapsed = Date.now() - new Date(operation.createdAt).getTime();
  if (options.timeoutMs != null && elapsed > options.timeoutMs) {
    throw new TimeoutError(`Remote capability ${options.capability.id} timed out`);
  }
  const result = await options.capability.recover(context, remoteTaskId);
  await options.store.appendHistory({
    runId: options.runId,
    type: "remote.task.status",
    payload: {
      capabilityId: options.capability.id,
      remoteTaskId,
      status: result.status,
    },
  });
  if (result.status === "working") {
    await yieldRemotePoll(options, remoteTaskId);
  }
  return result;
}

async function yieldRemotePoll(options: ExecuteRemoteCapabilityOptions, remoteTaskId: string): Promise<never> {
  const pollMs = options.pollMs ?? 50;
  await options.store.enqueueWork({
    runId: options.runId,
    type: "execute_run",
    availableAt: new Date(Date.now() + pollMs),
  });
  options.notifier?.ping();
  throw new WorkflowSuspend({ type: "join", ref: remoteTaskId });
}

async function cancelRemote(options: ExecuteRemoteCapabilityOptions, operation: RemoteOperation): Promise<void> {
  const remoteTaskId = operation.remoteTaskId;
  if (remoteTaskId && options.capability.cancel) {
    try {
      await options.capability.cancel(
        {
          runId: options.runId,
          executionId: options.runId,
          stepRunId: options.stepRunId ?? undefined,
          clientRequestId: operation.clientRequestId,
          abortSignal: options.abortSignal,
          attempt: operation.attempt,
        },
        remoteTaskId,
      );
    } catch (error) {
      await options.store.appendHistory({
        runId: options.runId,
        type: "capability.cancelled",
        payload: {
          capabilityId: options.capability.id,
          remoteTaskId,
          cancelFailed: true,
        },
      });
      throw new RemoteCancelFailedError(
        `Failed to cancel remote task ${remoteTaskId} for ${options.capability.id}`,
        error,
      );
    }
  }
  await options.store.updateRemoteOperation(operation.id, {
    status: "CANCELLED",
    completedAt: new Date().toISOString(),
  });
  await options.store.appendHistory({
    runId: options.runId,
    type: "capability.cancelled",
    payload: { capabilityId: options.capability.id, remoteTaskId: remoteTaskId ?? null },
  });
}

async function failRemote(
  options: ExecuteRemoteCapabilityOptions,
  operation: RemoteOperation,
  error: unknown,
): Promise<void> {
  await options.store.updateRemoteOperation(operation.id, {
    status: "FAILED",
    error: serializeError(error),
    completedAt: new Date().toISOString(),
  });
  await options.store.appendHistory({
    runId: options.runId,
    type: "capability.failed",
    payload: {
      capabilityId: options.capability.id,
      error: serializeError(error),
    },
  });
}

async function withInvokeTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number | null,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new CancellationError();
  }
  if (timeoutMs === null) {
    return fn();
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Capability timed out after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancellationError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    fn().then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

