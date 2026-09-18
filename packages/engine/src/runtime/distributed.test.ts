import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDrassos,
  StaleLeaseError,
  workflow,
  type Store,
  type WorkItem,
} from "../index.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

describe("distributed workers", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  const workers: Array<{ stop: (opts?: { drain?: boolean }) => Promise<void> }> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (workers.length > 0) {
      await workers.pop()?.stop({ drain: false });
    }
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("routes named queues and completes a workflow via in-process activity workers", async () => {
    const demo = workflow("queued-work", async (ctx) => {
      const billed = await ctx.activity("charge", { amount: 10 }, { queue: "payments" });
      const mailed = await ctx.activity("send-email", billed, { queue: "email" });
      return mailed;
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    engine.worker.activity("charge", async (_ctx, input) => ({ ...(input as object), charged: true }));
    engine.worker.activity("send-email", async (_ctx, input) => ({ ...(input as object), emailed: true }));
    await engine.startWorker();
    const run = await engine.executor.startRun("queued-work", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ charged: true, emailed: true });
  });

  it("rejects stale completion after another worker claims the task", async () => {
    const demo = workflow("stale-task", async (ctx) => ctx.activity("work", { n: 1 }, { queue: "jobs" }));
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      controlPlane: true,
      pollMs: 20,
      leaseMs: 250,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("stale-task", {});
    const first = await waitForClaim(engine, "jobs");
    await engine.store.expireWorkLease(first.id);
    const second = await waitForClaim(engine, "jobs");
    expect(second.id).toBe(first.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    await expect(
      engine.controlPlane.complete(first.id, {
        workerId: "ghost",
        leaseToken: first.leaseToken ?? "",
        result: { stolen: true },
      }),
    ).rejects.toBeInstanceOf(StaleLeaseError);
    await engine.controlPlane.complete(second.id, {
      workerId: second.leaseOwner ?? "w2",
      leaseToken: second.leaseToken ?? "",
      result: { ok: true },
    });
    await waitFor(async () => (await engine.store.getRun(second.runId))?.status === "COMPLETED");
  });

  it("treats duplicate completion with the same lease token as idempotent", async () => {
    const demo = workflow("dup-complete", async (ctx) => ctx.activity("once", { n: 1 }, { queue: "jobs" }));
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      controlPlane: true,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("dup-complete", {});
    const claimed = await waitForClaim(engine, "jobs");
    const first = await engine.controlPlane.complete(claimed.id, {
      workerId: claimed.leaseOwner ?? "w",
      leaseToken: claimed.leaseToken ?? "",
      result: { n: 1 },
    });
    const second = await engine.controlPlane.complete(claimed.id, {
      workerId: claimed.leaseOwner ?? "w",
      leaseToken: claimed.leaseToken ?? "",
      result: { n: 99 },
    });
    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBe(true);
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ n: 1 });
  });

  it("retries a failed task on another worker then dead-letters after exhaustion", async () => {
    const seen: string[] = [];
    const demo = workflow("retry-task", async (ctx) =>
      ctx.activity(
        "flaky",
        { n: 1 },
        { queue: "jobs", retry: { maxAttempts: 2, backoff: "none" } },
      ),
    );
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      controlPlane: true,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("retry-task", {});
    const first = await waitForClaim(engine, "jobs");
    seen.push(first.leaseOwner ?? "a");
    await engine.controlPlane.fail(first.id, {
      workerId: first.leaseOwner ?? "a",
      leaseToken: first.leaseToken ?? "",
      error: { message: "boom", retryable: true },
    });
    const second = await waitForClaim(engine, "jobs");
    expect(second.attempt).toBe(2);
    await engine.controlPlane.fail(second.id, {
      workerId: "b",
      leaseToken: second.leaseToken ?? "",
      error: { message: "still boom", retryable: true },
    });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "FAILED");
    const item = await engine.store.getWorkItem(second.id);
    expect(item?.status).toBe("dead");
    const metrics = await engine.store.getQueueMetrics();
    const jobs = metrics.find((row) => row.queue === "jobs");
    expect(jobs?.retries).toBeGreaterThanOrEqual(1);
    expect(jobs?.failed).toBeGreaterThanOrEqual(1);
  });

  it("keeps pending distributed tasks across a server restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drassos-v07-"));
    dirs.push(dir);
    const demo = workflow("persist-task", async (ctx) => ctx.activity("keep", { n: 1 }, { queue: "jobs" }));
    const firstEngine = await createDrassos({
      dataDir: dir,
      workflows: [demo],
      controlPlane: true,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    let runId: string;
    try {
      const run = await firstEngine.executor.startRun("persist-task", {});
      runId = run.id;
      await firstEngine.startWorker();
      await waitFor(async () => {
        const items = await firstEngine.store.getQueueMetrics();
        return items.some((row) => row.queue === "jobs" && row.pending >= 1);
      });
    } finally {
      await firstEngine.stop();
    }

    const secondEngine = await createDrassos({
      dataDir: dir,
      workflows: [demo],
      controlPlane: true,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(secondEngine);
    const { Worker } = await import("./worker.ts");
    const activityWorker = new Worker({
      id: "activity-w",
      store: secondEngine.store,
      executor: secondEngine.executor,
      notifier: secondEngine.notifier,
      logger: secondEngine.logger,
      leaseMs: 2_000,
      pollMs: 20,
    });
    activityWorker.activity("keep", async () => ({ kept: true }));
    await activityWorker.start();
    workers.push(activityWorker);
    await secondEngine.startWorker();
    await waitFor(async () => (await secondEngine.store.getRun(runId))?.status === "COMPLETED");
    expect((await secondEngine.store.getRun(runId))?.output).toMatchObject({ kept: true });
  });

  it("stops polling during drain while finishing the active task", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const demo = workflow("drain-task", async (ctx) => {
      const first = await ctx.activity("slow", { n: 1 }, { queue: "jobs" });
      const second = await ctx.activity("slow", { n: 2 }, { queue: "jobs" });
      return { first, second };
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
      concurrency: 1,
    });
    engines.push(engine);
    engine.worker.activity("slow", async (_ctx, input) => {
      started.push(String((input as { n: number }).n));
      if (started.length === 1) {
        await gate;
      }
      return input;
    });
    await engine.startWorker();
    const run = await engine.executor.startRun("drain-task", {});
    await waitFor(async () => started.length === 1);
    const draining = engine.worker.drain("500ms");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(started).toEqual(["1"]);
    release();
    await draining;
    expect(started).toEqual(["1"]);
    await engine.worker.stop();
    expect((await engine.store.getRun(run.id))?.status).toBe("WAITING");
  });

  it("issues only one valid lease under concurrent claimers", async () => {
    const demo = workflow("one-lease", async (ctx) => ctx.activity("job", { n: 1 }, { queue: "jobs" }));
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      controlPlane: true,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    await engine.executor.startRun("one-lease", {});
    await waitFor(async () =>
      (await engine.store.getQueueMetrics()).some((row) => row.queue === "jobs" && row.pending >= 1),
    );
    const [a, b] = await Promise.all([
      engine.store.claimWork("wa", { limit: 1, leaseMs: 2_000, queues: ["jobs"], types: ["activity"] }),
      engine.store.claimWork("wb", { limit: 1, leaseMs: 2_000, queues: ["jobs"], types: ["activity"] }),
    ]);
    const claimed = [...a, ...b];
    expect(claimed).toHaveLength(1);
  });

  it("drains a queue of many tasks without duplicate completions", async () => {
    const seen = new Map<number, number>();
    const demo = workflow("load", async (ctx) => {
      const results = [];
      for (let i = 0; i < 40; i += 1) {
        results.push(await ctx.activity(`item-${i}`, { i }, { queue: "jobs" }));
      }
      return results;
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 10,
      leaseMs: 3_000,
      logLevel: "silent",
      concurrency: 4,
    });
    engines.push(engine);
    for (let i = 0; i < 40; i += 1) {
      engine.worker.activity(`item-${i}`, async (_ctx, input) => {
        const n = (input as { i: number }).i;
        seen.set(n, (seen.get(n) ?? 0) + 1);
        return { i: n };
      });
    }
    await engine.startWorker();
    const run = await engine.executor.startRun("load", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED", 15_000);
    expect([...seen.values()].every((count) => count >= 1)).toBe(true);
    expect(seen.size).toBe(40);
  });
});

async function waitForClaim(engine: { store: Store }, queue: string): Promise<WorkItem> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const claimed = await engine.store.claimWork("claimer", {
      limit: 1,
      leaseMs: 2_000,
      queues: [queue],
      types: ["activity", "agent"],
    });
    if (claimed[0]) {
      return claimed[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out claiming from ${queue}`);
}
