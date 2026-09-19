import { createAgentApp, summarizeUser } from "./index.ts";
import { Drassos } from "@drassos/node";

const drassos = new Drassos({
  inMemory: true,
  pollMs: 20,
  app: createAgentApp(),
});
const result = await drassos.execute(summarizeUser, { userId: "user_1" });
console.log(JSON.stringify(result.output, null, 2));
await drassos.stop();
