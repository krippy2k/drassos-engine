# Drassos

A durable orchestration engine for TypeScript workflows. Workflows, AI agents, tools, humans, timers, and external events run as resumable operations. v0.9 adds workflow versions, deterministic replay, compatible-worker routing, and history export so you can change production workflows without breaking in-flight executions.

## What v0.9 includes

- Everything from v0.1–v0.8 (durable steps, agents, HITL, children, MCP/A2A, distributed workers, observability)
- Versioned workflow registration (`name@version`) with start-by-name or explicit version
- Deterministic `ctx.now()`, `ctx.random()`, and `ctx.uuid()`
- Read-only replay that never repeats tools, agents, activities, or other side effects
- Divergence reports for incompatible new code
- Worker routing so executions only run on compatible versions
- CLI: `replay`, `execution export`, `workflows required`

See [docs/workflow-evolution.md](docs/workflow-evolution.md), [docs/observability.md](docs/observability.md), [docs/execution-semantics.md](docs/execution-semantics.md), and [docs/worker-protocol.md](docs/worker-protocol.md).

## Quick start

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
import { defineApp, workflow } from "@drassos/engine";

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
```

Integration and crash-recovery tests use in-memory PGlite. No Docker required.

## Packages

```text
packages/engine     SDK, runtime, persistence, worker protocol, observability
packages/worker     DrassosWorker HTTP client
packages/api        HTTP API
packages/cli        drassos CLI
apps/console        React inspection UI
examples/refund-workflow
examples/observability-tour
examples/rolling-deploy
examples/distributed-workers
```
