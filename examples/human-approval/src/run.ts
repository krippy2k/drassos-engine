import { publishPost } from "./index.ts";
import { Drassos } from "@drassos/node";

const drassos = new Drassos({ inMemory: true, pollMs: 20, logLevel: "info" });
drassos.register(publishPost);
await drassos.start();
const started = await drassos.runtime().executor.startRun("publish-post", { title: "Launch notes" });
const waitUntil = Date.now() + 10_000;
while (Date.now() < waitUntil) {
  const pending = await drassos.getPendingInteractions(started.id);
  if (pending[0]) {
    await drassos.completeInteraction(started.id, "publish", { outcome: "approved" });
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const result = await drassos.wait(started.id);
console.log(JSON.stringify(result.output, null, 2));
await drassos.stop();
