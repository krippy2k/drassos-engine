# Drassos

A durable orchestration engine for TypeScript workflows. v0.1 proves that ordinary application code, AI agents, tools, human decisions, timers, and external events can participate as resumable operations across process crashes and worker restarts.

## What v0.1 includes

- TypeScript workflows (`ctx.step`, `ctx.agent`, `ctx.human`, `ctx.sleep`, `ctx.waitForEvent`, `ctx.parallel`)
- PostgreSQL-backed state, history, timers, events, human tasks, and work dispatch
- Local PGlite (Postgres-compatible) so `drassos dev` works without Docker
- Worker leases with `FOR UPDATE SKIP LOCKED`
- HTTP API, CLI, and a minimal inspection console
- Customer Refund reference workflow

See [docs/execution-semantics.md](docs/execution-semantics.md) for at-least-once delivery, operation identity, events, and cancellation.

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

Optional real Postgres:

```bash
docker compose up -d
set DATABASE_URL=postgres://drassos:drassos@localhost:5432/drassos
pnpm dev
```

## CLI

```text
drassos dev          # API + worker + console
drassos worker       # worker only
drassos workflows    # list registered workflows
drassos runs         # list recent runs
drassos run <name>   # start a run
drassos inspect <id> # print run detail JSON
```

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
| `POST` | `/workflows/:name/runs` | Start a run |
| `GET` | `/runs/:id` | Inspect a run |
| `POST` | `/runs/:id/cancel` | Cancel a run |
| `GET` | `/runs/:id/history` | Execution history |
| `POST` | `/runs/:id/events` | Deliver an external event |
| `GET` | `/human-tasks` | List human tasks |
| `POST` | `/human-tasks/:id/complete` | Complete a human task |
| `GET` | `/openapi.json` | OpenAPI document |

Authentication is intentionally omitted for local development. Middleware can be added at the Hono app boundary later.

## Tests

```bash
pnpm test
```

Integration and crash-recovery tests use in-memory PGlite. No Docker required.

## Packages

```text
packages/engine     SDK, runtime, persistence
packages/api        HTTP API
packages/cli        drassos CLI
apps/console        React inspection UI
examples/refund-workflow
```
