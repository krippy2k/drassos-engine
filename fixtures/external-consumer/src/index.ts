import { workflow } from "@drassos/core";
import { Drassos } from "@drassos/node";

const hello = workflow<{ name: string }, string>("hello", async (ctx) => {
  return ctx.step("greet", async () => `hello ${ctx.input.name}`);
});

const drassos = new Drassos({ inMemory: true, pollMs: 20, logLevel: "silent" });
const result = await drassos.execute(hello, { name: "Ada" });
if (result.status !== "COMPLETED" || result.output !== "hello Ada") {
  throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
}
await drassos.stop();
console.log("external-consumer ok");
