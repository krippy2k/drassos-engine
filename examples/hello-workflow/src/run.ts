import { hello } from "./index.ts";
import { Drassos } from "@drassos/node";

const drassos = new Drassos({ inMemory: true, pollMs: 20, logLevel: "info" });
drassos.register(hello);
const result = await drassos.execute(hello, { name: process.argv[2] ?? "world" });
console.log(JSON.stringify(result.output, null, 2));
await drassos.stop();
