import { afterEach, describe, expect, it } from "vitest";
import { workflow } from "@drassos/core";
import { createFakeClock, createTestRuntime, type TestRuntime } from "../src/index.ts";

describe("createTestRuntime", () => {
  const runtimes: TestRuntime[] = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()?.stop();
    }
  });

  it("completes a workflow and exposes history", async () => {
    const demo = workflow("test-hello", async (ctx) => {
      const stamped = ctx.now().toISOString();
      return ctx.step("echo", async () => ({ ok: true, stamped }));
    });
    const clock = createFakeClock();
    const runtime = await createTestRuntime({ clock });
    runtimes.push(runtime);
    const result = await runtime.execute(demo, {});
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toMatchObject({ ok: true, stamped: "2026-01-01T00:00:00.000Z" });
    const events = await runtime.history(result.runId);
    expect(events.some((event) => event.type === "workflow.completed")).toBe(true);
  });

  it("resumes after a human approval", async () => {
    const demo = workflow("test-approval", async (ctx) => {
      const decision = await ctx.approval({ id: "publish", title: "Publish?" });
      return { decision };
    });
    const runtime = await createTestRuntime();
    runtimes.push(runtime);
    const { runId } = await runtime.start(demo, {});
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      const pending = await runtime.getPendingInteractions(runId);
      if (pending.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await runtime.approve(runId, "publish", { note: "ship it" });
    const result = await runtime.wait(runId);
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toMatchObject({ decision: { outcome: "approved" } });
  });
});
