# @drassos/core

Platform-independent Drassos workflow, agent, and tool definitions.

Requires **Node.js 20+**. This package has no Node runtime, PostgreSQL, or worker implementation.

## Install

```bash
pnpm add @drassos/core
```

## Purpose

Use `@drassos/core` to author workflows, agents, and tools. Run them with [`@drassos/node`](../node/README.md) and test them with [`@drassos/testing`](../testing/README.md).

## Primary exports

```ts
import {
  defineApp,
  defineAgent,
  defineTool,
  defineWorkflow,
  workflow,
  agent,
  tool,
  TimeoutError,
} from "@drassos/core";
import { WorkflowRegistrationError } from "@drassos/core/errors";
```

Supported entry points:

- `@drassos/core`
- `@drassos/core/errors`
- `@drassos/core/types`

Deep imports such as `@drassos/core/src/...` are not supported.

## Usage

```ts
import { defineApp, workflow } from "@drassos/core";

export const hello = workflow("hello", async (ctx) => {
  const name = await ctx.step("load", async () => String(ctx.input.name));
  return { message: `hello ${name}` };
});

export default defineApp({ workflows: [hello] });
```
