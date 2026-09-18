import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { parseDuration } from "../core/duration.ts";
import { IncompatibleWorkerProtocolError, StaleLeaseError, UnknownActivityError, WorkerAuthError } from "../core/errors.ts";
import { DEFAULT_TASK_QUEUE } from "../core/types.ts";
import { createLogger, type Logger } from "../runtime/logger.ts";
import {
  WORKER_PROTOCOL_VERSION,
  type ActivityContext,
  type ActivityHandler,
  type AgentHandler,
  type TaskAckResponse,
  type WorkerPollResponse,
  type WorkerTaskView,
} from "./protocol.ts";

export interface DrassosWorkerOptions {
  server: string;
  token?: string;
  queues?: string[];
  concurrency?: number;
  capabilities?: string[];
  workerId?: string;
  version?: string;
  leaseMs?: number;
  pollMs?: number;
  shutdownTimeout?: string | number;
  logger?: Logger;
  workflowVersions?: string[];
}

export class DrassosWorker {
  private readonly activities = new Map<string, ActivityHandler>();
  private readonly agents = new Map<string, AgentHandler>();
  private running = false;
  private draining = false;
  private loops: Array<Promise<void>> = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private active = 0;
  private readonly aborts = new Set<AbortController>();
  readonly id: string;
  private readonly logger: Logger;

  constructor(private readonly options: DrassosWorkerOptions) {
    this.id = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.logger = options.logger ?? createLogger({ name: "drassos-worker" });
  }

  activity(name: string, handler: ActivityHandler): this {
    this.activities.set(name, handler);
    return this;
  }

  registerActivity(name: string, handler: ActivityHandler): this {
    return this.activity(name, handler);
  }

  agent(name: string, handler: AgentHandler): this {
    this.agents.set(name, handler);
    return this;
  }

  registerAgent(name: string, handler: AgentHandler): this {
    return this.agent(name, handler);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.draining = false;
    await this.rpc("POST", "/worker/register", {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerId: this.id,
      queues: this.queues,
      concurrency: this.concurrency,
      capabilities: this.options.capabilities ?? [...this.activities.keys(), ...this.agents.keys()],
      version: this.options.version ?? "0.7.0",
      hostname: hostname(),
      processId: process.pid,
      workflowVersions: this.options.workflowVersions ?? [],
    });
    this.heartbeatTimer = setInterval(() => {
      void this.rpc("POST", "/worker/heartbeat", {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerId: this.id,
        availableSlots: Math.max(0, this.concurrency - this.active),
        activeTasks: this.active,
        status: this.draining ? "draining" : "online",
      }).catch((error) => {
        this.logger.warn({ workerId: this.id, err: error }, "worker heartbeat failed");
      });
    }, Math.max(1_000, Math.floor((this.options.leaseMs ?? 30_000) / 3)));
    this.loops.push(this.pollLoop());
    this.logger.info({ workerId: this.id, queues: this.queues, concurrency: this.concurrency }, "remote worker started");
  }

  async drain(timeout?: string | number): Promise<void> {
    this.draining = true;
    await this.rpc("POST", "/worker/drain", {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerId: this.id,
    }).catch(() => undefined);
    const limit = timeout !== undefined ? parseDuration(timeout) : this.shutdownTimeoutMs;
    const started = Date.now();
    while (this.active > 0 && Date.now() - started < limit) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async stop(options?: { drain?: boolean; timeout?: string | number }): Promise<void> {
    this.running = false;
    if (options?.drain === false) {
      for (const abort of this.aborts) {
        abort.abort();
      }
    } else {
      await this.drain(options?.timeout);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    await Promise.allSettled(this.loops);
    this.loops = [];
    await this.rpc("POST", "/worker/disconnect", {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerId: this.id,
    }).catch(() => undefined);
    this.logger.info({ workerId: this.id }, "remote worker stopped");
  }

  private get queues(): string[] {
    return this.options.queues?.length ? this.options.queues : [DEFAULT_TASK_QUEUE];
  }

  private get concurrency(): number {
    return Math.max(1, this.options.concurrency ?? 5);
  }

  private get shutdownTimeoutMs(): number {
    return this.options.shutdownTimeout !== undefined
      ? parseDuration(this.options.shutdownTimeout)
      : 30_000;
  }

  private async pollLoop(): Promise<void> {
    const pollMs = this.options.pollMs ?? 200;
    while (this.running) {
      if (this.draining) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const availableSlots = this.concurrency - this.active;
      if (availableSlots <= 0) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      try {
        const response = (await this.rpc("POST", "/worker/tasks/poll", {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          workerId: this.id,
          queues: this.queues,
          availableSlots,
          waitMs: pollMs,
        })) as WorkerPollResponse;
        for (const task of response.tasks ?? []) {
          this.active += 1;
          void this.executeTask(task).finally(() => {
            this.active = Math.max(0, this.active - 1);
          });
        }
        if (!response.tasks?.length) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } catch (error) {
        this.logger.error({ workerId: this.id, err: error }, "worker poll failed");
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  }

  private async executeTask(task: WorkerTaskView): Promise<void> {
    const abort = new AbortController();
    this.aborts.add(abort);
    const payload = isRecord(task.payload) ? task.payload : {};
    const name = task.name ?? (typeof payload.name === "string" ? payload.name : "");
    const handler = task.type === "agent" ? this.agents.get(name) : this.activities.get(name);
    const heartbeat = setInterval(() => {
      void this.rpc("POST", `/worker/tasks/${task.id}/heartbeat`, {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerId: this.id,
        leaseToken: task.leaseToken,
      }).catch(() => undefined);
    }, Math.max(250, Math.floor((this.options.leaseMs ?? 30_000) / 3)));
    try {
      if (!handler) {
        throw new UnknownActivityError(name || task.type);
      }
      const ctx: ActivityContext = {
        taskId: task.id,
        workflowRunId: task.workflowRunId,
        runId: task.workflowRunId,
        queue: task.queue,
        attempt: task.attempt,
        idempotencyKey: task.idempotencyKey ?? `task:${task.workflowRunId}:${name}:${task.attempt}`,
        abortSignal: abort.signal,
        heartbeat: async (progress) => {
          await this.rpc("POST", `/worker/tasks/${task.id}/heartbeat`, {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            workerId: this.id,
            leaseToken: task.leaseToken,
            progress,
          });
        },
      };
      this.logger.info(
        {
          workerId: this.id,
          taskId: task.id,
          workflowRunId: task.workflowRunId,
          queue: task.queue,
          attempt: task.attempt,
          taskType: task.type,
        },
        "task started",
      );
      const result = await handler(ctx, payload.input);
      await this.rpc("POST", `/worker/tasks/${task.id}/complete`, {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerId: this.id,
        leaseToken: task.leaseToken,
        result: result ?? null,
      });
      this.logger.info(
        {
          workerId: this.id,
          taskId: task.id,
          workflowRunId: task.workflowRunId,
          queue: task.queue,
          attempt: task.attempt,
          taskType: task.type,
        },
        "task completed",
      );
    } catch (error) {
      if (abort.signal.aborted) {
        return;
      }
      const retryable = !(error instanceof UnknownActivityError);
      const ack = (await this.rpc("POST", `/worker/tasks/${task.id}/fail`, {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        workerId: this.id,
        leaseToken: task.leaseToken,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          retryable,
        },
      }).catch((failError) => failError)) as TaskAckResponse | Error;
      this.logger.warn(
        {
          workerId: this.id,
          taskId: task.id,
          workflowRunId: task.workflowRunId,
          queue: task.queue,
          attempt: task.attempt,
          taskType: task.type,
          err: error,
        },
        "task failed",
      );
      if (ack instanceof StaleLeaseError) {
        return;
      }
    } finally {
      clearInterval(heartbeat);
      this.aborts.delete(abort);
    }
  }

  private async rpc(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-drassos-worker-protocol": WORKER_PROTOCOL_VERSION,
    };
    if (this.options.token) {
      headers.authorization = `Bearer ${this.options.token}`;
    }
    const response = await fetch(`${this.options.server.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
      protocolVersion?: string;
    };
    if (json.protocolVersion && json.protocolVersion !== WORKER_PROTOCOL_VERSION) {
      throw new IncompatibleWorkerProtocolError(json.protocolVersion);
    }
    if (!response.ok) {
      const code = json.error?.code;
      const message = json.error?.message ?? `Worker RPC ${path} failed (${response.status})`;
      if (code === "STALE_LEASE") {
        throw new StaleLeaseError(message);
      }
      if (code === "WORKER_AUTH_ERROR") {
        throw new WorkerAuthError(message);
      }
      if (code === "INCOMPATIBLE_WORKER_PROTOCOL") {
        throw new IncompatibleWorkerProtocolError(message);
      }
      throw new Error(message);
    }
    return json;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
