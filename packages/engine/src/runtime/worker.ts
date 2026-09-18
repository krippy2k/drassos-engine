import { hostname } from "node:os";
import { parseDuration } from "../core/duration.ts";
import { toJson } from "../core/serialize.ts";
import { UnknownActivityError, CompatibleWorkerMissing } from "../core/errors.ts";
import { DEFAULT_TASK_QUEUE, type WorkItem, type WorkItemType } from "../core/types.ts";
import type { Store } from "../persistence/store.ts";
import { fireDueTimers, Executor } from "./executor.ts";
import type { Logger } from "./logger.ts";
import type { WorkNotifier } from "./notifier.ts";
import type { WorkflowRegistry } from "./registry.ts";
import { WorkerControlPlane } from "../worker/control-plane.ts";
import { isDistributedTaskType, type ActivityHandler, type AgentHandler } from "../worker/protocol.ts";

export class Worker {
  private running = false;
  private draining = false;
  private loops: Array<Promise<void>> = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly activities = new Map<string, ActivityHandler>();
  private readonly agents = new Map<string, AgentHandler>();
  private readonly plane: WorkerControlPlane;
  private active = 0;

  constructor(
    private readonly options: {
      id: string;
      store: Store;
      executor: Executor;
      notifier: WorkNotifier;
      logger: Logger;
      leaseMs: number;
      pollMs?: number;
      concurrency?: number;
      queues?: string[];
      types?: WorkItemType[];
      shutdownTimeout?: string | number;
      workerToken?: string;
      registry?: WorkflowRegistry;
      workflowVersions?: string[];
    },
  ) {
    this.plane = new WorkerControlPlane({
      store: options.store,
      notifier: options.notifier,
      logger: options.logger,
      leaseMs: options.leaseMs,
      workerToken: options.workerToken,
    });
  }

  get id(): string {
    return this.options.id;
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
    await this.options.store.upsertWorker(
      this.options.id,
      { startedAt: new Date().toISOString() },
      {
        queues: this.options.queues ?? [DEFAULT_TASK_QUEUE],
        capabilities: [...this.activities.keys(), ...this.agents.keys()],
        workflowVersions: this.advertisedVersions() ?? [],
        concurrency: this.options.concurrency ?? 1,
        status: "online",
        hostname: hostname(),
        processId: process.pid,
        protocolVersion: "1",
        availableSlots: this.options.concurrency ?? 1,
      },
    );
    const workers = this.options.concurrency ?? 1;
    for (let i = 0; i < workers; i += 1) {
      this.loops.push(this.claimLoop());
    }
    this.loops.push(this.timerLoop());
    this.heartbeatTimer = setInterval(() => {
      void this.options.store.heartbeatWorker(this.options.id, {
        availableSlots: Math.max(0, (this.options.concurrency ?? 1) - this.active),
        activeTasks: this.active,
        status: this.draining ? "draining" : "online",
        workflowVersions: this.advertisedVersions(),
      });
    }, Math.max(1_000, Math.floor(this.options.leaseMs / 3)));
    this.options.logger.info({ workerId: this.options.id }, "worker started");
  }

  async drain(timeout?: string | number): Promise<void> {
    this.draining = true;
    const limit = timeout !== undefined ? parseDuration(timeout) : this.shutdownTimeoutMs;
    const started = Date.now();
    while (this.active > 0 && Date.now() - started < limit) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async stop(options?: { drain?: boolean; timeout?: string | number }): Promise<void> {
    this.running = false;
    if (options?.drain !== false) {
      await this.drain(options?.timeout);
    }
    this.options.notifier.ping();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    await Promise.all(this.loops);
    this.loops = [];
    await this.options.store.heartbeatWorker(this.options.id, { status: "offline", activeTasks: 0, availableSlots: 0 });
    this.options.logger.info({ workerId: this.options.id }, "worker stopped");
  }

  private get shutdownTimeoutMs(): number {
    return this.options.shutdownTimeout !== undefined ? parseDuration(this.options.shutdownTimeout) : 30_000;
  }

  private advertisedVersions(): string[] | undefined {
    if (this.options.workflowVersions) {
      return this.options.workflowVersions;
    }
    if (this.options.registry) {
      return this.options.registry.advertised();
    }
    return undefined;
  }

  private claimTypes(): WorkItemType[] {
    if (this.options.types) {
      return this.options.types;
    }
    const types: WorkItemType[] = ["execute_run", "fire_timer"];
    if (this.activities.size > 0) {
      types.push("activity", "tool", "mcp-tool", "custom");
    }
    if (this.agents.size > 0) {
      types.push("agent");
    }
    return types;
  }

  private async claimLoop(): Promise<void> {
    const pollMs = this.options.pollMs ?? 200;
    while (this.running) {
      if (this.draining) {
        await this.options.notifier.wait(pollMs);
        continue;
      }
      try {
        const items = await this.options.store.claimWork(this.options.id, {
          limit: 1,
          leaseMs: this.options.leaseMs,
          queues: this.options.queues,
          types: this.claimTypes(),
          workflowVersions: this.advertisedVersions(),
        });
        if (items.length === 0) {
          await this.options.store.markWaitingForCompatibleWorker();
          await this.options.notifier.wait(pollMs);
          continue;
        }
        for (const item of items) {
          this.active += 1;
          try {
            if (isDistributedTaskType(item.type)) {
              await this.executeDistributed(item);
              continue;
            }
            const acquired = await this.options.store.tryAcquireRun(
              item.runId,
              this.options.id,
              this.options.leaseMs,
            );
            if (!acquired) {
              const run = await this.options.store.getRun(item.runId);
              if (!run || run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED") {
                await this.options.store.completeWork(item.id, { leaseToken: item.leaseToken ?? undefined });
              } else {
                await this.options.store.expireWorkLease(item.id);
              }
              continue;
            }
            const heartbeat = setInterval(() => {
              void this.options.store.heartbeatWork(
                item.id,
                this.options.id,
                this.options.leaseMs,
                item.leaseToken ?? undefined,
              );
              void this.options.store.heartbeatRun(item.runId, this.options.id, this.options.leaseMs);
            }, Math.max(250, Math.floor(this.options.leaseMs / 3)));
            try {
              if (item.type === "fire_timer") {
                await fireDueTimers(this.options.store, this.options.notifier);
              } else {
                await this.options.executor.executeRun(item.runId);
              }
              await this.options.store.completeWork(item.id, { leaseToken: item.leaseToken ?? undefined });
            } catch (error) {
              if (error instanceof CompatibleWorkerMissing) {
                await this.options.store.expireWorkLease(item.id);
                await this.options.store.markWaitingForCompatibleWorker();
              } else {
                this.options.logger.error(
                  { workerId: this.options.id, runId: item.runId, err: error },
                  "work item failed; lease will expire for recovery",
                );
              }
            } finally {
              clearInterval(heartbeat);
              await this.options.store.releaseRun(item.runId, this.options.id);
            }
          } finally {
            this.active = Math.max(0, this.active - 1);
          }
        }
      } catch (error) {
        this.options.logger.error({ workerId: this.options.id, err: error }, "worker loop error");
        await this.options.notifier.wait(pollMs);
      }
    }
  }

  private async executeDistributed(item: WorkItem): Promise<void> {
    const payload = item.payload && typeof item.payload === "object" && !Array.isArray(item.payload) ? item.payload : {};
    const name = item.name ?? (typeof payload.stepName === "string" ? payload.stepName : "");
    const handler = item.type === "agent" ? this.agents.get(name) : this.activities.get(name);
    const heartbeat = setInterval(() => {
      void this.options.store.heartbeatWork(item.id, this.options.id, this.options.leaseMs, item.leaseToken ?? undefined);
    }, Math.max(250, Math.floor(this.options.leaseMs / 3)));
    try {
      if (!handler) {
        throw new UnknownActivityError(name || item.type);
      }
      const result = await handler(
        {
          taskId: item.id,
          workflowRunId: item.runId,
          runId: item.runId,
          queue: item.queue,
          attempt: item.attempt,
          idempotencyKey: item.idempotencyKey ?? `task:${item.runId}:${name}:${item.attempt}`,
          abortSignal: new AbortController().signal,
          heartbeat: async (progress) => {
            if (!item.leaseToken) {
              return;
            }
            await this.options.store.heartbeatWork(item.id, this.options.id, this.options.leaseMs, item.leaseToken);
            if (progress !== undefined) {
              await this.options.store.updateWorkProgress(item.id, item.leaseToken, progress);
            }
          },
        },
        payload.input,
      );
      await this.plane.complete(item.id, {
        workerId: this.options.id,
        leaseToken: item.leaseToken ?? "",
        result: toJson(result ?? null),
      });
      this.options.logger.info(
        {
          workerId: this.options.id,
          taskId: item.id,
          workflowRunId: item.runId,
          queue: item.queue,
          attempt: item.attempt,
          taskType: item.type,
        },
        "task completed",
      );
    } catch (error) {
      await this.plane
        .fail(item.id, {
          workerId: this.options.id,
          leaseToken: item.leaseToken ?? "",
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
            retryable: !(error instanceof UnknownActivityError),
          },
        })
        .catch((failError) => {
          this.options.logger.warn({ workerId: this.options.id, taskId: item.id, err: failError }, "task fail report rejected");
        });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async timerLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.options.store.recoverExpiredLeases();
        await fireDueTimers(this.options.store, this.options.notifier);
        await this.options.executor.failTimedOutChildren();
        await this.options.executor.recoverWaitingParents();
        await this.options.store.markWaitingForCompatibleWorker();
      } catch (error) {
        this.options.logger.error({ workerId: this.options.id, err: error }, "timer loop error");
      }
      await this.options.notifier.wait(this.options.pollMs ?? 200);
    }
  }
}
