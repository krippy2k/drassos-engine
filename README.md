# Drassos

A durable orchestration engine for TypeScript workflows. Workflows, AI agents, tools, humans, timers, and external events run as resumable operations.

v0.10 packages Drassos as an SDK: `@drassos/core`, `@drassos/node`, and `@drassos/testing`. v0.9 workflow versions, replay, and compatible workers remain available.

## Quick start (SDK)

Requires Node.js 20+.

```bash
pnpm add @drassos/core @drassos/node
pnpm add -D @drassos/testing
```

```ts
import { workflow } from "@drassos/core";
import { Drassos } from "@drassos/node";

const hello = workflow("hello", async (ctx) => {
  const name = await ctx.step("load", async () => String(ctx.input.name));
  return { message: `hello ${name}` };
});

const drassos = new Drassos({ inMemory: true });
const result = await drassos.execute(hello, { name: "Ada" });
await drassos.stop();
```

See [docs/sdk.md](docs/sdk.md) and the `examples/hello-workflow`, `examples/agent-workflow`, and `examples/human-approval` packages.

## Repository development

```bash
pnpm install
pnpm --filter @drassos/console build
pnpm dev
```

Then:

```bash
pnpm drassos run customer-refund --input "{\"customerId\":\"cust_100\",\"amount\":180,\"reason\":\"damaged item\",\"sleepDuration\":\"2s\"}"
```

Open `http://127.0.0.1:3100` for the console. Complete the human task, wait for the timer, then deliver the confirmation event:

```bash
curl -X POST http://127.0.0.1:3100/runs/<run-id>/events \
  -H "content-type: application/json" \
  -d "{\"type\":\"refund.confirmed\",\"data\":{\"paymentId\":\"pay_123\"}}"
```

See [docs/observability.md](docs/observability.md) for the debugger, traces, and metrics.

Optional real Postgres:

```bash
docker compose up -d
set DATABASE_URL=postgres://drassos:drassos@localhost:5432/drassos
pnpm dev
```

## CLI

```text
drassos dev                 # API + local worker + console
drassos dev --control-plane # API + orchestration only (remote workers execute activities)
drassos worker              # local worker
drassos worker --server http://127.0.0.1:3100 --queues agents,tools
drassos workflows           # list registered workflows
drassos runs                # list recent runs
drassos run <name>          # start a run
drassos inspect <id>        # print run detail JSON
drassos replay <id>         # replay an execution against registered code
drassos execution export <id>
drassos workflows required  # versions still needed by active runs
```

Set `DRASSOS_WORKER_TOKEN` so remote workers authenticate with `Authorization: Bearer`.

## Defining a workflow

```ts
import { defineApp, workflow } from "@drassos/core";

export const demo = workflow("demo", async (ctx) => {
  const customer = await ctx.step("load-customer", () => loadCustomer(ctx.input.customerId));
  const analysis = await ctx.agent("analyze", { agent: refundAgent, input: customer });
  if (analysis.requiresApproval) {
    await ctx.human("approve", { title: "Approve", assignedTo: "support", data: analysis });
  }
  await ctx.sleep("24h");
  const payment = await ctx.waitForEvent("payment.received");
  return { customer, payment };
});

export default defineApp({ workflows: [demo] });
```

Existing apps that import `@drassos/engine` continue to work.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/workflows/:name/runs` | Start a run (`version` optional) |
| `GET` | `/workflows` | Registered workflow versions |
| `GET` | `/workflows/required` | Active executions by version |
| `GET` | `/runs/:id` | Inspect a run |
| `POST` | `/runs/:id/cancel` | Cancel a run |
| `GET` | `/runs/:id/history` | Execution history |
| `GET` | `/runs/:id/trace` | Observability hierarchy |
| `GET` | `/runs/:id/graph` | Execution graph |
| `GET` | `/runs/:id/events` | Paginated history events |
| `GET` | `/runs/:id/stream` | Live SSE updates |
| `POST` | `/runs/:id/fork` | Fork a new run from a history seq |
| `GET` | `/runs/:id/export` | Export history for offline replay |
| `POST` | `/runs/:id/replay` | Replay against a candidate version |
| `POST` | `/runs/:id/events` | Deliver an external event |
| `GET` | `/human-tasks` | List human tasks |
| `POST` | `/human-tasks/:id/complete` | Complete a human task |
| `POST` | `/worker/register` | Register a remote worker |
| `POST` | `/worker/tasks/poll` | Claim leased tasks |
| `GET` | `/metrics/queues` | Queue metrics |
| `GET` | `/metrics/overview` | Observability metrics |
| `GET` | `/workers` | Worker status |
| `GET` | `/openapi.json` | OpenAPI document |

`/api/...` aliases exist for the workflow/run observability routes. Authentication is intentionally omitted for local development. Middleware can be added at the Hono app boundary later.

## Tests

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm pack:all
pnpm smoke:pack
```

Integration and crash-recovery tests use in-memory PGlite. No Docker required.

## Packages

```text
packages/core       Public definitions and types
packages/node       Node runtime bootstrap
packages/testing    createTestRuntime
packages/engine     Implementation used by @drassos/node
packages/worker     DrassosWorker HTTP client
packages/api        HTTP API
packages/cli        drassos CLI
apps/console        React inspection UI
examples/hello-workflow
examples/agent-workflow
examples/human-approval
examples/refund-workflow
examples/observability-tour
examples/rolling-deploy
examples/distributed-workers
```
