import { afterEach, describe, expect, it } from "vitest";
import { workflow } from "@drassos/core";
import { Drassos } from "../src/index.ts";

describe("Drassos bootstrap", () => {
  const runtimes: Drassos[] = [];

  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()?.stop();
    }
  });

  it("executes a registered workflow through the public class", async () => {
    const hello = workflow<{ name: string }, { message: string }>("sdk-hello", async (ctx) => {
      const name = await ctx.step("load", async () => ctx.input.name);
      return { message: `hello ${name}` };
    });
    const drassos = new Drassos({ inMemory: true, pollMs: 20, logLevel: "silent" });
    runtimes.push(drassos);
    drassos.register(hello);
    const result = await drassos.execute(hello, { name: "Ada" });
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ message: "hello Ada" });
  });
});
