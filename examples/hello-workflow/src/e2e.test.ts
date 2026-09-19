import { afterEach, describe, expect, it } from "vitest";
import { hello } from "./index.ts";
import { createTestRuntime, type TestRuntime } from "@drassos/testing";

describe("hello-workflow", () => {
  const runtimes: TestRuntime[] = [];
  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()?.stop();
    }
  });

  it("returns a greeting", async () => {
    const runtime = await createTestRuntime();
    runtimes.push(runtime);
    const result = await runtime.execute(hello, { name: "Ada" });
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ message: "hello Ada" });
  });
});
