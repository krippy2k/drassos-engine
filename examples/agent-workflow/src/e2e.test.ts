import { afterEach, describe, expect, it } from "vitest";
import { createAgentApp, summarizeUser } from "./index.ts";
import { createTestRuntime, type TestRuntime } from "@drassos/testing";

describe("agent-workflow", () => {
  const runtimes: TestRuntime[] = [];
  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()?.stop();
    }
  });

  it("runs an agent with a tool", async () => {
    const app = createAgentApp();
    const runtime = await createTestRuntime({
      workflows: app.workflows,
      tools: app.tools,
      models: app.models,
    });
    runtimes.push(runtime);
    const result = await runtime.execute(summarizeUser, { userId: "user_1" });
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toMatchObject({ summary: "Ada is on the pro plan." });
  });
});
