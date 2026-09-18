import { afterEach, describe, expect, it } from "vitest";
import { createDrassos, Worker } from "@drassos/engine";
import { createApi as createHttpApi } from "@drassos/api";
import rollingApp, { orderProcessingV1, orderProcessingV2, resetSideEffects, sideEffects } from "./index.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("rolling deploy example", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  const workers: Array<{ stop: (opts?: { drain?: boolean }) => Promise<void> }> = [];

  afterEach(async () => {
    resetSideEffects();
    while (workers.length > 0) {
      await workers.pop()?.stop({ drain: false });
    }
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("keeps v1 executions on v1 while v2 deploys, and replay detects incompatibility", async () => {
    const engine = await createDrassos({
      inMemory: true,
      workflows: [orderProcessingV1],
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();

    const v1 = await engine.executor.startRun("order-processing", { orderId: "ord-1", amount: 42 }, undefined, {
      version: "1.0.0",
    });
    await waitFor(async () => (await engine.store.getRun(v1.id))?.status === "WAITING");
    expect((await engine.store.getRun(v1.id))?.workflowVersion).toBe("1.0.0");
    expect(sideEffects.charges).toBe(1);

    engine.registry.register(orderProcessingV2);
    await engine.store.registerWorkflow(orderProcessingV2.name, orderProcessingV2.version);

    const v2 = await engine.executor.startRun("order-processing", { orderId: "ord-2", amount: 9 }, undefined, {
      version: "2.0.0",
    });
    await waitFor(async () => (await engine.store.getRun(v2.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(v2.id))?.output).toMatchObject({ version: "2.0.0" });

    const tasks = await engine.store.listHumanTasks({ runId: v1.id, status: "pending" });
    await engine.executor.completeHumanTask(tasks[0]!.id, { approved: true });
    await waitFor(async () => (await engine.store.getRun(v1.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(v1.id))?.output).toMatchObject({ version: "1.0.0" });

    const chargesBeforeReplay = sideEffects.charges;
    const chargesV2BeforeReplay = sideEffects.chargesV2;
    const compatible = await engine.replay(v1.id, { definition: orderProcessingV1 });
    expect(compatible.ok).toBe(true);
    expect(compatible.divergences).toHaveLength(0);
    expect(sideEffects.charges).toBe(chargesBeforeReplay);
    expect(sideEffects.chargesV2).toBe(chargesV2BeforeReplay);

    const divergent = await engine.replay(v1.id, { definition: orderProcessingV2 });
    expect(divergent.ok).toBe(false);
    expect(divergent.divergences[0]?.kind).toMatch(/OPERATION_|ORDER_|INPUT_|BRANCH_/);
    expect(sideEffects.charges).toBe(chargesBeforeReplay);
    expect(sideEffects.chargesV2).toBe(chargesV2BeforeReplay);

    const exported = await engine.exportExecution(v1.id);
    expect(exported.formatVersion).toBe(1);
    expect(exported.execution.workflowVersion).toBe("1.0.0");
    expect(JSON.stringify(exported)).not.toMatch(/secret/i);

    const api = createHttpApi({ drassos: engine });
    const replayed = await api.request(`/runs/${v1.id}/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0" }),
    });
    expect(replayed.status).toBe(200);
    const body = (await replayed.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("routes executions only to compatible workers and waits when none remain", async () => {
    const engine = await createDrassos({
      inMemory: true,
      workflows: [orderProcessingV1, orderProcessingV2],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    const workerA = new Worker({
      id: "worker-a",
      store: engine.store,
      executor: engine.executor,
      notifier: engine.notifier,
      logger: engine.logger,
      leaseMs: 2_000,
      pollMs: 20,
      workflowVersions: ["order-processing@1.0.0"],
    });
    const workerB = new Worker({
      id: "worker-b",
      store: engine.store,
      executor: engine.executor,
      notifier: engine.notifier,
      logger: engine.logger,
      leaseMs: 2_000,
      pollMs: 20,
      workflowVersions: ["order-processing@2.0.0"],
    });
    workers.push(workerA, workerB);
    await workerA.start();
    await workerB.start();

    const v1 = await engine.executor.startRun("order-processing", { orderId: "ord-a", amount: 5 }, undefined, {
      version: "1.0.0",
    });
    const v2 = await engine.executor.startRun("order-processing", { orderId: "ord-b", amount: 6 }, undefined, {
      version: "2.0.0",
    });
    await waitFor(async () => (await engine.store.getRun(v1.id))?.status === "WAITING");
    await waitFor(async () => (await engine.store.getRun(v2.id))?.status === "COMPLETED");

    await workerA.stop({ drain: false });
    const tasks = await engine.store.listHumanTasks({ runId: v1.id, status: "pending" });
    await engine.executor.completeHumanTask(tasks[0]!.id, { approved: true });
    await waitFor(async () => {
      const run = await engine.store.getRun(v1.id);
      return run?.waitType === "compatible-worker" || (await engine.store.countWaitingForWorker()) > 0;
    });
    expect((await engine.store.getRun(v1.id))?.status).not.toBe("COMPLETED");
    expect((await engine.store.getRun(v1.id))?.status).not.toBe("FAILED");

    await workerA.start();
    await waitFor(async () => (await engine.store.getRun(v1.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(v1.id))?.output).toMatchObject({ version: "1.0.0" });
  });

  it("loads both versions through defineApp", () => {
    expect(rollingApp.workflows.map((item) => `${item.name}@${item.version}`)).toEqual([
      "order-processing@1.0.0",
      "order-processing@2.0.0",
    ]);
  });
});
