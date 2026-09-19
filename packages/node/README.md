# @drassos/node

Node.js runtime, persistence, workers, and bootstrap for Drassos.

Requires **Node.js 20+**. Depends on [`@drassos/core`](../core/README.md) for definitions.

## Install

```bash
pnpm add @drassos/core @drassos/node
```

## Purpose

Start a Drassos engine in a server process: in-memory PGlite, PostgreSQL, workers, MCP/A2A, and observability configuration.

## Primary exports

```ts
import { Drassos, createDrassos, ScriptedModelProvider } from "@drassos/node";
```

`database` is an alias for `databaseUrl`. Omit both and pass `inMemory: true` for local/dev/testing.

## Usage

```ts
import { workflow } from "@drassos/core";
import { Drassos } from "@drassos/node";

const hello = workflow("hello", async (ctx) => {
  return ctx.step("greet", async () => `hello ${ctx.input.name}`);
});

const drassos = new Drassos({ inMemory: true });
drassos.register(hello);
await drassos.start();
const result = await drassos.execute(hello, { name: "Ada" });
await drassos.stop();
```

Postgres:

```ts
const drassos = new Drassos({
  database: process.env.DATABASE_URL,
});
```
