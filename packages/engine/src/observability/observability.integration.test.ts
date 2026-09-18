import { afterEach, describe, expect, it } from "vitest";
import { createDrassos, workflow } from "../index.ts";

describe("observability store filters and fork", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("filters runs and forks from a historical seq", async () => {
    const demo = workflow("obs-filter", async (ctx) => {
      const first = await ctx.step("one", async () => ({ n: 1 }));
      const second = await ctx.step("two", async () => ({ n: first.n + 1 }));
      return second;
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [demo],
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const a = await engine.executor.startRun("obs-filter", {});
    const b = await engine.executor.startRun("obs-filter", {});
    const wait = async (id: string) => {
      const started = Date.now();
      while (Date.now() - started < 8_000) {
        const run = await engine.store.getRun(id);
        if (run?.status === "COMPLETED") {
          return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("timeout");
    };
    await wait(a.id);
    await wait(b.id);
    const listed = await engine.observability.listRuns({ workflow: "obs-filter", status: "COMPLETED" });
    expect(listed.total).toBe(2);
    expect(listed.runs.every((item) => item.workflowName === "obs-filter")).toBe(true);

    const history = await engine.store.listHistory(a.id);
    const completed = history.find((event) => event.type === "step.completed");
    expect(completed).toBeTruthy();
    const fork = await engine.executor.forkRun(a.id, completed!.seq);
    expect(fork.id).not.toBe(a.id);
    expect(fork.forkedFromRunId).toBe(a.id);
    expect(fork.forkedFromSeq).toBe(completed!.seq);
    const copied = await engine.store.listSteps(fork.id);
    expect(copied.some((step) => step.name === "one" && step.status === "COMPLETED")).toBe(true);
  });
});
