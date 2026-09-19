import { afterEach, describe, expect, it } from "vitest";
import { publishPost } from "./index.ts";
import { createTestRuntime, type TestRuntime } from "@drassos/testing";

describe("human-approval", () => {
  const runtimes: TestRuntime[] = [];
  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()?.stop();
    }
  });

  it("suspends until a human approves", async () => {
    const runtime = await createTestRuntime();
    runtimes.push(runtime);
    const { runId } = await runtime.start(publishPost, { title: "Launch notes" });
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      const pending = await runtime.getPendingInteractions(runId);
      if (pending.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await runtime.approve(runId, "publish");
    const result = await runtime.wait(runId);
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toMatchObject({
      title: "Launch notes",
      decision: { outcome: "approved" },
    });
  });
});
