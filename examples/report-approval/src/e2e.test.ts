import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDrassos } from "@drassos/engine";
import { createReportApp, demoState, resetDemoState } from "./index.ts";

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

describe("report approval demo", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    resetDemoState();
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

  it("publishes after human approval", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createReportApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("report-approval", { topic: "HITL" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    const pending = await engine.getPendingInteractions(run.id);
    expect(pending[0]?.interactionId).toBe("publish-report");
    await engine.completeInteraction(run.id, "publish-report", { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ status: "published" });
    expect(demoState.published).toBe(1);
  });

  it("returns rejection from the human decision", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createReportApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("report-approval", { topic: "HITL" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.completeInteraction(run.id, "publish-report", {
      outcome: "rejected",
      reason: "Unsupported conclusions",
    });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({
      status: "rejected",
      reason: "Unsupported conclusions",
    });
    expect(demoState.published).toBe(0);
  });

  it("revises after changes are requested, then publishes", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createReportApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("report-approval", { topic: "HITL" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.completeInteraction(run.id, "publish-report", {
      outcome: "changes_requested",
      feedback: "Add citations to the final section.",
    });
    await waitFor(async () => {
      const pending = await engine.getPendingInteractions(run.id);
      return pending.some((item) => item.interactionId === "publish-report-r1");
    });
    await engine.completeInteraction(run.id, "publish-report-r1", { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({
      status: "published",
      report: { body: expect.stringContaining("citations") },
    });
    expect(demoState.published).toBe(1);
  });

  it("supports more than one revision round", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createReportApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("report-approval", { topic: "HITL" });
    await waitFor(async () => (await engine.getPendingInteractions(run.id)).some((item) => item.interactionId === "publish-report"));
    await engine.completeInteraction(run.id, "publish-report", {
      outcome: "changes_requested",
      feedback: "Add citations.",
    });
    await waitFor(async () =>
      (await engine.getPendingInteractions(run.id)).some((item) => item.interactionId === "publish-report-r1"),
    );
    await engine.completeInteraction(run.id, "publish-report-r1", {
      outcome: "changes_requested",
      feedback: "Shorten the intro.",
    });
    await waitFor(async () =>
      (await engine.getPendingInteractions(run.id)).some((item) => item.interactionId === "publish-report-r2"),
    );
    await engine.completeInteraction(run.id, "publish-report-r2", { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({
      status: "published",
      report: { body: expect.stringContaining("Shorten the intro") },
    });
  });

  it("survives process restart while approval is pending, then publishes once", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "drassos-report-"));
    dirs.push(dataDir);
    const first = await createDrassos({
      dataDir,
      app: createReportApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    await first.startWorker();
    const run = await first.executor.startRun("report-approval", { topic: "HITL" });
    await waitFor(async () => (await first.store.getRun(run.id))?.status === "WAITING");
    const pendingBefore = await first.getPendingInteractions(run.id);
    expect(pendingBefore[0]?.status).toBe("pending");
    await first.stop();

    resetDemoState();
    const second = await createDrassos({
      dataDir,
      app: createReportApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(second);
    await second.startWorker();
    const stillWaiting = await second.store.getRun(run.id);
    expect(stillWaiting?.status).toBe("WAITING");
    const pendingAfter = await second.getPendingInteractions(run.id);
    expect(pendingAfter[0]?.interactionId).toBe("publish-report");
    await second.completeInteraction(run.id, "publish-report", { outcome: "approved" });
    await waitFor(async () => (await second.store.getRun(run.id))?.status === "COMPLETED");
    expect((await second.store.getRun(run.id))?.output).toMatchObject({ status: "published" });
    expect(demoState.published).toBe(1);
  });
});
