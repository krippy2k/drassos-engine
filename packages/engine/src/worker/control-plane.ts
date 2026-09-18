import { hostname } from "node:os";
import {
  IncompatibleWorkerProtocolError,
  StaleLeaseError,
  TaskPayloadTooLargeError,
  WorkerAuthError,
} from "../core/errors.ts";
import { computeBackoffMs, normalizeRetry } from "../core/retry.ts";
import type { Json, RetryPolicy, WorkItem } from "../core/types.ts";
import { DEFAULT_TASK_QUEUE } from "../core/types.ts";
import type { Store } from "../persistence/store.ts";
import type { Logger } from "../runtime/logger.ts";
import type { WorkNotifier } from "../runtime/notifier.ts";
import {
  DISTRIBUTED_TASK_TYPES,
  MAX_TASK_PAYLOAD_BYTES,
  WORKER_PROTOCOL_VERSION,
  payloadSizeBytes,
  toPersistedWorkerError,
  type TaskAckResponse,
  type TaskCompleteRequest,
  type TaskFailRequest,
  type TaskHeartbeatRequest,
  type WorkerHeartbeatRequest,
  type WorkerPollRequest,
  type WorkerPollResponse,
  type WorkerRegisterRequest,
  type WorkerTaskView,
} from "./protocol.ts";

export class WorkerControlPlane {
  constructor(
    private readonly options: {
      store: Store;
      notifier: WorkNotifier;
      logger: Logger;
      leaseMs: number;
      workerToken?: string;
    },
  ) {}

  assertAuth(header?: string | null): void {
    const expected = this.options.workerToken;
    if (!expected) {
      return;
    }
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : header?.trim();
    if (token !== expected) {
      throw new WorkerAuthError();
    }
  }

  assertProtocol(version?: string): void {
    if (version && version !== WORKER_PROTOCOL_VERSION) {
      throw new IncompatibleWorkerProtocolError(version);
    }
  }

  async register(request: WorkerRegisterRequest): Promise<{ ok: true; workerId: string }> {
    this.assertProtocol(request.protocolVersion);
    const queues = request.queues.length ? request.queues : [DEFAULT_TASK_QUEUE];
    await this.options.store.upsertWorker(
      request.workerId,
      { startedAt: new Date().toISOString() },
      {
        queues,
        capabilities: request.capabilities ?? [],
        concurrency: request.concurrency,
        status: "online",
        version: request.version,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        hostname: request.hostname ?? hostname(),
        processId: request.processId ?? process.pid,
        availableSlots: request.concurrency,
        activeTasks: 0,
        workflowVersions: request.workflowVersions ?? [],
      },
    );
    this.options.logger.info(
      { workerId: request.workerId, queues, concurrency: request.concurrency },
      "worker registered",
    );
    return { ok: true, workerId: request.workerId };
  }

  async heartbeat(request: WorkerHeartbeatRequest): Promise<{ ok: true }> {
    this.assertProtocol(request.protocolVersion);
    await this.options.store.heartbeatWorker(request.workerId, {
      availableSlots: request.availableSlots,
      activeTasks: request.activeTasks,
      status: request.status,
    });
    return { ok: true };
  }

  async drain(workerId: string, protocolVersion?: string): Promise<{ ok: true }> {
    this.assertProtocol(protocolVersion);
    await this.options.store.heartbeatWorker(workerId, { status: "draining", availableSlots: 0 });
    return { ok: true };
  }

  async disconnect(workerId: string, protocolVersion?: string): Promise<{ ok: true }> {
    this.assertProtocol(protocolVersion);
    await this.options.store.heartbeatWorker(workerId, { status: "offline", availableSlots: 0, activeTasks: 0 });
    return { ok: true };
  }

  async poll(request: WorkerPollRequest): Promise<WorkerPollResponse> {
    this.assertProtocol(request.protocolVersion);
    const limit = Math.max(0, Math.min(request.availableSlots, 32));
    const waitMs = Math.max(0, Math.min(request.waitMs ?? 2_000, 30_000));
    const deadline = Date.now() + waitMs;
    if (limit === 0) {
      return { protocolVersion: WORKER_PROTOCOL_VERSION, tasks: [] };
    }
    await this.options.store.heartbeatWorker(request.workerId, {
      availableSlots: limit,
      status: "online",
    });
    while (true) {
      const claimed = await this.options.store.claimWork(request.workerId, {
        limit,
        leaseMs: this.options.leaseMs,
        queues: request.queues,
        types: DISTRIBUTED_TASK_TYPES,
      });
      if (claimed.length > 0) {
        for (const item of claimed) {
          await this.options.store.appendHistory({
            runId: item.runId,
            type: "task.leased",
            payload: {
              taskId: item.id,
              workerId: request.workerId,
              queue: item.queue,
              attempt: item.attempt,
              type: item.type,
            },
          });
        }
        await this.options.store.heartbeatWorker(request.workerId, {
          availableSlots: Math.max(0, limit - claimed.length),
          activeTasks: claimed.length,
        });
        return { protocolVersion: WORKER_PROTOCOL_VERSION, tasks: claimed.map(toTaskView) };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { protocolVersion: WORKER_PROTOCOL_VERSION, tasks: [] };
      }
      await this.options.notifier.wait(Math.min(200, remaining));
    }
  }

  async heartbeatTask(taskId: string, request: TaskHeartbeatRequest): Promise<{ ok: true }> {
    this.assertProtocol(request.protocolVersion);
    const ok = await this.options.store.heartbeatWork(
      taskId,
      request.workerId,
      this.options.leaseMs,
      request.leaseToken,
    );
    if (!ok) {
      throw new StaleLeaseError(taskId);
    }
    if (request.progress !== undefined) {
      await this.options.store.updateWorkProgress(taskId, request.leaseToken, request.progress);
    }
    return { ok: true };
  }

  async complete(taskId: string, request: TaskCompleteRequest): Promise<TaskAckResponse> {
    this.assertProtocol(request.protocolVersion);
    if (request.result !== undefined && payloadSizeBytes(request.result) > MAX_TASK_PAYLOAD_BYTES) {
      throw new TaskPayloadTooLargeError(payloadSizeBytes(request.result));
    }
    const existing = await this.options.store.getWorkItem(taskId);
    if (!existing) {
      throw new StaleLeaseError(taskId);
    }
    if (existing.status === "completed" && existing.leaseToken === request.leaseToken) {
      return { protocolVersion: WORKER_PROTOCOL_VERSION, ok: true, duplicate: true, status: "completed" };
    }
    const completed = await this.options.store.completeWork(taskId, {
      result: request.result ?? null,
      leaseToken: request.leaseToken,
    });
    await this.options.store.appendHistory({
      runId: completed.runId,
      type: "task.completed",
      payload: { taskId, workerId: request.workerId, queue: completed.queue, attempt: completed.attempt },
    });
    await this.finishDistributedTask(completed, { ok: true, result: completed.result });
    return { protocolVersion: WORKER_PROTOCOL_VERSION, ok: true, status: completed.status };
  }

  async fail(taskId: string, request: TaskFailRequest): Promise<TaskAckResponse> {
    this.assertProtocol(request.protocolVersion);
    const existing = await this.options.store.getWorkItem(taskId);
    if (!existing) {
      throw new StaleLeaseError(taskId);
    }
    const retryable = request.error.retryable !== false && existing.attempt < existing.maxAttempts;
    const retry = retryPolicyFromPayload(existing.payload);
    const delay = retryable ? computeBackoffMs(retry, existing.attempt) : 0;
    const failed = await this.options.store.failWork(taskId, toPersistedWorkerError(request.error), {
      leaseToken: request.leaseToken,
      retryable,
      retryAt: new Date(Date.now() + delay),
    });
    await this.options.store.appendHistory({
      runId: failed.runId,
      type: failed.status === "pending" ? "task.retrying" : "task.failed",
      payload: {
        taskId,
        workerId: request.workerId,
        queue: failed.queue,
        attempt: failed.attempt,
        error: failed.error,
      },
    });
    if (failed.status === "dead") {
      await this.finishDistributedTask(failed, { ok: false, error: failed.error });
    } else {
      this.options.notifier.ping();
    }
    return { protocolVersion: WORKER_PROTOCOL_VERSION, ok: true, status: failed.status };
  }

  private async finishDistributedTask(
    item: WorkItem,
    outcome: { ok: true; result: Json | null } | { ok: false; error: WorkItem["error"] },
  ): Promise<void> {
    const stepId = stepIdFromPayload(item.payload);
    if (stepId) {
      if (outcome.ok) {
        await this.options.store.updateStep(stepId, {
          status: "COMPLETED",
          output: outcome.result,
          completedAt: new Date().toISOString(),
          error: null,
        });
        await this.options.store.appendHistory({
          runId: item.runId,
          type: "step.completed",
          payload: { stepId, name: item.name, attempt: item.attempt },
        });
      } else {
        await this.options.store.updateStep(stepId, {
          status: "FAILED",
          error: outcome.error,
          completedAt: new Date().toISOString(),
        });
        await this.options.store.appendHistory({
          runId: item.runId,
          type: "step.failed",
          payload: { stepId, name: item.name, attempt: item.attempt, error: outcome.error },
        });
      }
    }
    await this.options.store.enqueueWork({ runId: item.runId, type: "execute_run" });
    this.options.notifier.ping();
  }
}

export function toTaskView(item: WorkItem): WorkerTaskView {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    queue: item.queue,
    workflowRunId: item.runId,
    payload: item.payload,
    attempt: item.attempt,
    maxAttempts: item.maxAttempts,
    idempotencyKey: item.idempotencyKey,
    leaseToken: item.leaseToken ?? "",
    leaseExpiresAt: item.leaseExpiresAt ?? new Date().toISOString(),
  };
}

function stepIdFromPayload(payload: Json): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return typeof payload.stepId === "string" ? payload.stepId : null;
}

function retryPolicyFromPayload(payload: Json): RetryPolicy {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.retry) {
    return normalizeRetry();
  }
  return normalizeRetry(payload.retry as unknown as RetryPolicy);
}
