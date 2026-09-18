import { afterEach, describe, expect, it } from "vitest";
import { createDrassos } from "@drassos/engine";
import { createApi } from "@drassos/api";
import refundApp from "./index.ts";
import { counters, resetDemoData } from "./services.ts";

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("customer refund workflow", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    resetDemoData();
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("runs the high-value refund path end to end", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: refundApp,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("customer-refund", {
      customerId: "cust_100",
      amount: 180,
      reason: "damaged item",
      sleepDuration: 40,
    });

    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    expect(counters.loadCustomer).toBe(1);
    let tasks = await engine.store.listHumanTasks({ runId: run.id, status: "pending" });
    expect(tasks).toHaveLength(1);

    await engine.worker.stop();
    expect((await engine.store.getRun(run.id))?.status).toBe("WAITING");
    await engine.startWorker();
    tasks = await engine.store.listHumanTasks({ runId: run.id, status: "pending" });
    expect(tasks[0]?.status).toBe("pending");

    await engine.executor.completeHumanTask(tasks[0]!.id, { approved: true });
    await waitFor(async () => {
      const current = await engine.store.getRun(run.id);
      return current?.status === "WAITING" && current.waitType === "timer";
    });
    expect(counters.issueRefund).toBe(1);
    expect(counters.loadCustomer).toBe(1);

    await engine.worker.stop();
    await engine.startWorker();
    await waitFor(async () => {
      const current = await engine.store.getRun(run.id);
      return current?.status === "WAITING" && current.waitType === "event";
    });
    expect(counters.issueRefund).toBe(1);

    const firstDelivery = await engine.executor.deliverEvent(
      run.id,
      "refund.confirmed",
      { paymentId: "pay_123" },
      "evt-1",
    );
    const duplicate = await engine.executor.deliverEvent(
      run.id,
      "refund.confirmed",
      { paymentId: "pay_123" },
      "evt-1",
    );
    expect(duplicate.eventId).toBe(firstDelivery.eventId);
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");

    const history = await engine.store.listHistory(run.id);
    const types = history.map((event) => event.type);
    expect(types).toContain("workflow.started");
    expect(types).toContain("agent.completed");
    expect(types).toContain("tool.completed");
    expect(types).toContain("human.created");
    expect(types).toContain("human.completed");
    expect(types).toContain("timer.created");
    expect(types).toContain("timer.fired");
    expect(types).toContain("event.received");
    expect(types).toContain("event.consumed");
    expect(types).toContain("workflow.completed");
    expect(counters.lookupOrders).toBeGreaterThan(0);
    expect(counters.lookupRefundHistory).toBeGreaterThan(0);
  });

  it("exposes run and human-task HTTP APIs", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: refundApp,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const app = createApi({ drassos: engine });

    const created = await app.request("/workflows/customer-refund/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: {
          customerId: "cust_200",
          amount: 40,
          reason: "too small",
          sleepDuration: 30,
        },
      }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };
    await waitFor(async () => (await engine.store.getRun(run.id))?.waitType === "event");

    const eventRes = await app.request(`/runs/${run.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "refund.confirmed", data: { ok: true } }),
    });
    expect(eventRes.status).toBe(202);
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");

    const detail = await app.request(`/runs/${run.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { run: { status: string }; history: unknown[] };
    expect(body.run.status).toBe("COMPLETED");
    expect(body.history.length).toBeGreaterThan(5);

    const spec = await app.request("/openapi.json");
    expect(spec.status).toBe(200);
  });
});
