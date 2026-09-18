import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDrassos } from "@drassos/engine";
import { createResearchApp, demoState, resetDemoState } from "./index.ts";

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

describe("multi-agent research demo", () => {
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

  it("runs planner, parallel specialists, writer, then publishes after approval", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createResearchApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("multi-agent-research", { topic: "durable agents" });
    await waitFor(async () => (await engine.getPendingInteractions(run.id)).some((item) => item.interactionId === "publish-research"));
    const tree = await engine.getExecutionTree(run.id);
    expect(tree.name).toBe("multi-agent-research");
    expect(tree.children.some((child) => child.type === "agent" && child.name === "planner")).toBe(true);
    expect(tree.children.filter((child) => child.type === "agent").length).toBeGreaterThanOrEqual(4);
    await engine.completeInteraction(run.id, "publish-research", { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const output = (await engine.store.getRun(run.id))?.output as { status: string };
    expect(output.status).toBe("published");
    expect(demoState.plans).toBe(1);
    expect(demoState.specialistRuns).toBe(3);
    expect(demoState.published).toBe(1);
  });

  it("survives restart while specialists have completed and approval is pending", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "drassos-research-"));
    dirs.push(dataDir);
    const first = await createDrassos({
      dataDir,
      app: createResearchApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    await first.startWorker();
    const run = await first.executor.startRun("multi-agent-research", { topic: "HITL trees" });
    await waitFor(async () => (await first.getPendingInteractions(run.id)).length > 0);
    const treeBefore = await first.getExecutionTree(run.id);
    const completedAgents = treeBefore.children.filter((child) => child.type === "agent" && child.status === "COMPLETED");
    expect(completedAgents.length).toBeGreaterThanOrEqual(4);
    await first.stop();

    resetDemoState();
    const second = await createDrassos({
      dataDir,
      app: createResearchApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(second);
    await second.startWorker();
    const stillWaiting = await second.store.getRun(run.id);
    expect(stillWaiting?.status).toBe("WAITING");
    const treeAfter = await second.getExecutionTree(run.id);
    expect(treeAfter.children.filter((child) => child.type === "agent" && child.status === "COMPLETED").length).toBe(
      completedAgents.length,
    );
    await second.completeInteraction(run.id, "publish-research", { outcome: "approved" });
    await waitFor(async () => (await second.store.getRun(run.id))?.status === "COMPLETED");
    expect(demoState.published).toBe(1);
    expect(demoState.plans).toBe(0);
  });

  it("propagates cancellation to active descendants", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createResearchApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("multi-agent-research", { topic: "cancel me" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.cancelExecution(run.id, "stop research");
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "CANCELLED");
    const children = await engine.store.listChildren(run.id);
    for (const child of children) {
      expect(["CANCELLED", "COMPLETED", "FAILED"]).toContain(child.status);
    }
  });
});
