#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const cli = await import("../src/index.ts");
await cli.runCli(process.argv);
