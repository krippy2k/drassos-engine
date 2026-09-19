# @drassos/testing

In-memory test helpers for Drassos applications.

Requires **Node.js 20+**. Depends on [`@drassos/core`](../core/README.md) and [`@drassos/node`](../node/README.md).

## Install

```bash
pnpm add -D @drassos/testing
```

## Purpose

Run workflows in an isolated PGlite runtime without a production deployment. Deliver signals, complete human approvals, inspect history, and optionally inject a fake clock for `ctx.now()`.

## Primary exports

```ts
import { createTestRuntime, createFakeClock } from "@drassos/testing";
```

## Usage

```ts
import { workflow } from "@drassos/core";
import { createTestRuntime } from "@drassos/testing";

const hello = workflow("hello", async (ctx) => {
  return ctx.step("greet", async () => `hello ${ctx.input.name}`);
});

const runtime = await createTestRuntime();
const result = await runtime.execute(hello, { name: "Ada" });
expect(result.status).toBe("COMPLETED");
await runtime.stop();
```
