import { afterEach, describe, expect, it } from "vitest";
import {
  createDrassos,
  InteractionAlreadyCompletedError,
  parseHumanDecision,
  SignalNotAllowedError,
  workflow,
} from "../index.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

describe("v0.4 signals and human interactions", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => {
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("serializes human decisions", () => {
    expect(parseHumanDecision({ outcome: "approved", data: { ok: true } })).toEqual({
      outcome: "approved",
      data: { ok: true },
    });
    expect(parseHumanDecision({ outcome: "rejected", reason: "no" })).toEqual({
      outcome: "rejected",
      reason: "no",
    });
    expect(parseHumanDecision({ outcome: "changes_requested", feedback: "more" })).toEqual({
      outcome: "changes_requested",
      feedback: "more",
    });
    expect(() => parseHumanDecision({ outcome: "changes_requested" })).toThrow(/feedback/);
  });

  it("waits for a signal and resumes with the payload", async () => {
    const demo = workflow("sig-basic", async (ctx) => {
      const payment = await ctx.waitForSignal<{ amount: number }>("payment-received");
      return { payment };
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("sig-basic", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.signal(run.id, "payment-received", { amount: 42 });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual({ payment: { amount: 42 } });
    const history = await engine.store.listHistory(run.id);
    expect(history.map((event) => event.type)).toEqual(
      expect.arrayContaining(["signal.received", "signal.wait.started", "signal.wait.completed"]),
    );
  });

  it("consumes a signal that arrived before the wait", async () => {
    const demo = workflow("sig-buffer", async (ctx) => {
      await ctx.sleep("pause", 80);
      return ctx.waitForSignal<{ n: number }>("ready");
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("sig-buffer", {});
    await engine.signal(run.id, "ready", { n: 7 });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual({ n: 7 });
  });

  it("consumes same-name signals in recorded order", async () => {
    const demo = workflow("sig-order", async (ctx) => {
      const a = await ctx.waitForSignal<{ id: string }>("message");
      const b = await ctx.waitForSignal<{ id: string }>("message");
      const c = await ctx.waitForSignal<{ id: string }>("message");
      return [a.id, b.id, c.id];
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("sig-order", {});
    await engine.signal(run.id, "message", { id: "A" });
    await engine.signal(run.id, "message", { id: "B" });
    await engine.signal(run.id, "message", { id: "C" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual(["A", "B", "C"]);
  });

  it("ignores duplicate signal ids", async () => {
    const demo = workflow("sig-dup", async (ctx) => {
      const first = await ctx.waitForSignal<{ n: number }>("tick");
      const second = await ctx.waitForSignal<{ n: number }>("tick");
      return [first.n, second.n];
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("sig-dup", {});
    const one = await engine.signal(run.id, "tick", { n: 1 }, { id: "x" });
    const again = await engine.signal(run.id, "tick", { n: 1 }, { id: "x" });
    expect(again.duplicate).toBe(true);
    expect(again.signalId).toBe(one.signalId);
    await engine.signal(run.id, "tick", { n: 2 }, { id: "y" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual([1, 2]);
  });

  it("times out a signal wait without consuming a later signal", async () => {
    const demo = workflow("sig-timeout", async (ctx) => {
      const first = await ctx.waitForSignal("late", { timeout: 40 });
      const second = await ctx.waitForSignal<{ ok: boolean }>("late");
      return { first, second };
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("sig-timeout", {});
    await waitFor(async () => {
      const current = await engine.store.getRun(run.id);
      return current?.status === "WAITING" || current?.status === "COMPLETED";
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await engine.signal(run.id, "late", { ok: true });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual({
      first: { timedOut: true },
      second: { ok: true },
    });
  });

  it("rejects signaling a completed workflow", async () => {
    const demo = workflow("sig-done", async () => ({ ok: true }));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("sig-done", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    await expect(engine.signal(run.id, "nope", {})).rejects.toBeInstanceOf(SignalNotAllowedError);
  });

  it("creates, approves, and records a human interaction", async () => {
    const demo = workflow("human-ok", async (ctx) =>
      ctx.approval({ id: "publish-report", title: "Publish?" }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("human-ok", {});
    await waitFor(async () => (await engine.getPendingInteractions(run.id)).length === 1);
    const got = await engine.getInteraction(run.id, "publish-report");
    expect(got?.title).toBe("Publish?");
    await engine.completeInteraction(run.id, "publish-report", { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ outcome: "approved" });
    await expect(
      engine.completeInteraction(run.id, "publish-report", { outcome: "rejected", reason: "no" }),
    ).rejects.toBeInstanceOf(InteractionAlreadyCompletedError);
    const duplicate = await engine.completeInteraction(run.id, "publish-report", { outcome: "approved" });
    expect(duplicate.status).toBe("approved");
  });

  it("returns request-changes feedback to the workflow", async () => {
    const demo = workflow("human-changes", async (ctx) =>
      ctx.approval({ id: "review", title: "Review" }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("human-changes", {});
    await waitFor(async () => (await engine.getPendingInteractions(run.id)).length === 1);
    await engine.completeInteraction(run.id, "review", {
      outcome: "changes_requested",
      feedback: "Add citations",
    });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({
      outcome: "changes_requested",
      feedback: "Add citations",
    });
  });

  it("times out a human approval", async () => {
    const demo = workflow("human-timeout", async (ctx) =>
      ctx.approval({ id: "review", title: "Review", timeout: 40 }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("human-timeout", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ outcome: "timed_out" });
    const interaction = await engine.getInteraction(run.id, "review");
    expect(interaction?.status).toBe("timed_out");
  });

  it("keeps a buffered signal across worker restart", async () => {
    const demo = workflow("sig-crash", async (ctx) => ctx.waitForSignal<{ ok: boolean }>("go"));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("sig-crash", {});
    await engine.signal(run.id, "go", { ok: true });
    await engine.worker.stop();
    await engine.startWorker();
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual({ ok: true });
  });

  it("keeps a pending approval across worker restart", async () => {
    const demo = workflow("human-crash", async (ctx) => {
      const decision = await ctx.approval({ id: "publish-report", title: "Publish?" });
      const saved = await ctx.step("after", async () => ({ once: true, decision }));
      return saved;
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("human-crash", {});
    await waitFor(async () => (await engine.getPendingInteractions(run.id)).length === 1);
    await engine.worker.stop();
    expect((await engine.getPendingInteractions(run.id))[0]?.status).toBe("pending");
    await engine.startWorker();
    await engine.completeInteraction(run.id, "publish-report", { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ once: true });
  });
});
