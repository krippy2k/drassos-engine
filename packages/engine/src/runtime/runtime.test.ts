import { afterEach, describe, expect, it } from "vitest";
import { createDrassos } from "./create-drassos.ts";
import { workflow } from "../sdk/workflow.ts";
import { defineAgent } from "../sdk/app.ts";
import { tool } from "../sdk/agent.ts";
import { ScriptedAgentProvider } from "../agents/providers.ts";
import { z } from "zod";

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 8_000,
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

describe("durable runtime", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("does not re-execute completed steps after a worker stop/start on the same store", async () => {
    const counts = { load: 0, save: 0 };
    const demo = workflow("crash-resume-shared", async (ctx) => {
      await ctx.step("load", async () => {
        counts.load += 1;
        return "loaded";
      });
      await ctx.sleep("hold", 80);
      await ctx.step("save", async () => {
        counts.save += 1;
        return "saved";
      });
      return "ok";
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("crash-resume-shared", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    expect(counts.load).toBe(1);
    await engine.worker.stop();
    await engine.startWorker();
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect(counts.load).toBe(1);
    expect(counts.save).toBe(1);
  });

  it("retries failed steps with backoff and eventually succeeds", async () => {
    let attempts = 0;
    const demo = workflow("retry-me", async (ctx) => {
      return ctx.step(
        "flaky",
        { retry: { maxAttempts: 3, backoff: "fixed", initialIntervalMs: 20 } },
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("not yet");
          }
          return "ok";
        },
      );
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("retry-me", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect(attempts).toBe(3);
    const steps = await engine.store.listSteps(run.id);
    expect(steps[0]?.attempt).toBe(3);
  });

  it("times out a hung step", async () => {
    const demo = workflow("timeout-me", async (ctx) => {
      await ctx.step("slow", { timeout: 40 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return "never";
      });
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("timeout-me", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "FAILED");
    const failed = await engine.store.getRun(run.id);
    expect(failed?.error?.name).toBe("TimeoutError");
  });

  it("waits for human input without occupying a worker, then resumes", async () => {
    const demo = workflow("needs-human", async (ctx) => {
      const decision = await ctx.human("approve", {
        title: "Approve",
        assignedTo: "ops",
        data: { amount: 12 },
      });
      return decision;
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("needs-human", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    const tasks = await engine.store.listHumanTasks({ status: "pending" });
    expect(tasks).toHaveLength(1);
    await engine.executor.completeHumanTask(tasks[0]!.id, { approved: true, note: "ok" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const completed = await engine.store.getRun(run.id);
    expect(completed?.output).toEqual({ approved: true, note: "ok" });
  });

  it("matches events by type and consumes the first unconsumed payload", async () => {
    const demo = workflow("needs-event", async (ctx) => {
      const first = await ctx.waitForEvent<{ id: string }>("payment.received");
      const second = await ctx.waitForEvent<{ id: string }>("payment.received");
      return { first, second };
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("needs-event", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.executor.deliverEvent(run.id, "payment.received", { id: "pay_1" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.executor.deliverEvent(run.id, "ignored", { id: "nope" });
    await engine.executor.deliverEvent(run.id, "payment.received", { id: "pay_2" }, "dup-1");
    await engine.executor.deliverEvent(run.id, "payment.received", { id: "pay_2" }, "dup-1");
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const completed = await engine.store.getRun(run.id);
    expect(completed?.output).toEqual({ first: { id: "pay_1" }, second: { id: "pay_2" } });
    const events = await engine.store.listEvents(run.id);
    expect(events.filter((event) => event.deliveryId === "dup-1")).toHaveLength(1);
  });

  it("cancels waiting work without rewriting completed steps", async () => {
    const demo = workflow("cancel-me", async (ctx) => {
      await ctx.step("before", async () => "done");
      await ctx.sleep("later", 5_000);
      await ctx.step("after", async () => "nope");
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("cancel-me", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.executor.cancelRun(run.id, "test");
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "CANCELLED");
    const steps = await engine.store.listSteps(run.id);
    expect(steps.find((step) => step.name === "before")?.status).toBe("COMPLETED");
    expect(steps.find((step) => step.name === "after")).toBeUndefined();
  });

  it("recovers abandoned work after a lease expires", async () => {
    const counts = { n: 0 };
    const demo = workflow("lease-recovery", async (ctx) => {
      await ctx.step("work", async () => {
        counts.n += 1;
        return counts.n;
      });
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 500,
      logLevel: "silent",
      workerId: "w1",
    });
    engines.push(engine);
    const run = await engine.executor.startRun("lease-recovery", {});
    const claimed = await engine.store.claimWork("ghost", { limit: 1, leaseMs: 200 });
    expect(claimed).toHaveLength(1);
    await engine.startWorker();
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED", 6_000);
    expect(counts.n).toBe(1);
  });

  it("allows two workers to claim distinct work without double-executing a run", async () => {
    const counts = { n: 0 };
    const demo = workflow("single-active", async (ctx) => {
      await ctx.step("work", async () => {
        counts.n += 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return "ok";
      });
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
      workerId: "alpha",
    });
    engines.push(engine);
    const { Worker } = await import("./worker.ts");
    const second = new Worker({
      id: "beta",
      store: engine.store,
      executor: engine.executor,
      notifier: engine.notifier,
      logger: engine.logger,
      leaseMs: 2_000,
      pollMs: 20,
    });
    await engine.startWorker();
    await second.start();
    try {
      const run = await engine.executor.startRun("single-active", {});
      await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
      expect(counts.n).toBe(1);
    } finally {
      await second.stop();
    }
  });

  it("records agent and tool history", async () => {
    const lookup = tool({
      name: "lookup",
      description: "lookup",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ id, ok: true }),
    });
    const agent = defineAgent({
      name: "analyst",
      instructions: "use tools",
      tools: [lookup],
      provider: new ScriptedAgentProvider([
        {
          output: null,
          toolCalls: [{ id: "1", name: "lookup", arguments: { id: "abc" } }],
        },
        { output: { summary: "fine" } },
      ]),
    });
    const demo = workflow("with-agent", async (ctx) => {
      return ctx.agent("analyze", { agent, input: { id: "abc" } });
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("with-agent", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const tools = await engine.store.listToolInvocations(run.id);
    const agents = await engine.store.listAgentExecutions(run.id);
    const history = await engine.store.listHistory(run.id);
    expect(tools).toHaveLength(1);
    expect(agents).toHaveLength(1);
    expect(history.some((event) => event.type === "tool.completed")).toBe(true);
    expect(history.some((event) => event.type === "agent.completed")).toBe(true);
  });

  it("runs parallel steps", async () => {
    const demo = workflow("parallel", async (ctx) => {
      return ctx.parallel([
        () => ctx.step("a", async () => 1),
        () => ctx.step("b", async () => 2),
      ]);
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("parallel", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual([1, 2]);
  });
});
