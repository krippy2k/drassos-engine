import { fireDueTimers, Executor } from "./executor.ts";
import type { Store } from "../persistence/store.ts";
import type { Logger } from "./logger.ts";
import type { WorkNotifier } from "./notifier.ts";

export class Worker {
  private running = false;
  private loops: Array<Promise<void>> = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;

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
    },
  ) {}

  get id(): string {
    return this.options.id;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.options.store.upsertWorker(this.options.id, { startedAt: new Date().toISOString() });
    const workers = this.options.concurrency ?? 1;
    for (let i = 0; i < workers; i += 1) {
      this.loops.push(this.claimLoop());
    }
    this.loops.push(this.timerLoop());
    this.heartbeatTimer = setInterval(() => {
      void this.options.store.heartbeatWorker(this.options.id);
    }, Math.max(1_000, Math.floor(this.options.leaseMs / 3)));
    this.options.logger.info({ workerId: this.options.id }, "worker started");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.options.notifier.ping();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    await Promise.all(this.loops);
    this.loops = [];
    this.options.logger.info({ workerId: this.options.id }, "worker stopped");
  }

  private async claimLoop(): Promise<void> {
    const pollMs = this.options.pollMs ?? 200;
    while (this.running) {
      try {
        const items = await this.options.store.claimWork(this.options.id, {
          limit: 1,
          leaseMs: this.options.leaseMs,
        });
        if (items.length === 0) {
          await this.options.notifier.wait(pollMs);
          continue;
        }
        for (const item of items) {
          const acquired = await this.options.store.tryAcquireRun(
            item.runId,
            this.options.id,
            this.options.leaseMs,
          );
          if (!acquired) {
            const run = await this.options.store.getRun(item.runId);
            if (!run || run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED") {
              await this.options.store.completeWork(item.id);
            } else {
              await this.options.store.expireWorkLease(item.id);
            }
            continue;
          }
          const heartbeat = setInterval(() => {
            void this.options.store.heartbeatWork(item.id, this.options.id, this.options.leaseMs);
            void this.options.store.heartbeatRun(item.runId, this.options.id, this.options.leaseMs);
          }, Math.max(250, Math.floor(this.options.leaseMs / 3)));
          try {
            if (item.type === "fire_timer") {
              await fireDueTimers(this.options.store, this.options.notifier);
            } else {
              await this.options.executor.executeRun(item.runId);
            }
            await this.options.store.completeWork(item.id);
          } catch (error) {
            this.options.logger.error(
              { workerId: this.options.id, runId: item.runId, err: error },
              "work item failed; lease will expire for recovery",
            );
          } finally {
            clearInterval(heartbeat);
            await this.options.store.releaseRun(item.runId, this.options.id);
          }
        }
      } catch (error) {
        this.options.logger.error({ workerId: this.options.id, err: error }, "worker loop error");
        await this.options.notifier.wait(pollMs);
      }
    }
  }

  private async timerLoop(): Promise<void> {
    while (this.running) {
      try {
        await fireDueTimers(this.options.store, this.options.notifier);
        await this.options.executor.recoverWaitingParents();
      } catch (error) {
        this.options.logger.error({ workerId: this.options.id, err: error }, "timer loop error");
      }
      await this.options.notifier.wait(this.options.pollMs ?? 200);
    }
  }
}
