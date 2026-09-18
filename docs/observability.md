# Observability, Debugger, and Web UI (v0.8)

Drassos v0.8 projects durable history into a read-only observability model. Workflow semantics do not change: steps, agents, tools, humans, and children still persist the same way. The UI and management APIs read that history.

## Starting the UI

```bash
pnpm --filter @drassos/console build
pnpm dev
```

Open `http://127.0.0.1:3100`. The console is served from the same origin as the API.

During frontend development:

```bash
pnpm --filter @drassos/console dev
```

Vite on port 3200 proxies `/runs`, `/api`, `/metrics`, and related paths to `127.0.0.1:3100`.

The default dashboard lists recent executions with workflow, status, current step, and duration. Filter by workflow, status, agent, or failures. Open a run for the graph, timeline, inspector, snapshot slider, and live updates.

## Configuring observability

Pass `observability` to `createDrassos`:

```ts
await createDrassos({
  observability: {
    payloads: "full",          // full | metadata-only | disabled
    modelPrompts: "metadata-only",
    modelResponses: "full",
    toolArguments: "full",
    recordPrompts: true,
    modelRates: {
      "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
  },
});
```

Field-specific capture overrides `payloads`. `recordPrompts: false` (and the similar v0.3 flags) maps to `disabled` for that field.

Secrets whose keys match `secret`, `password`, `token`, `api_key`, `authorization`, `credential`, or `private_key` are always redacted as `[redacted]`.

Trace, graph, and log endpoints apply this policy. Observability failures never fail a workflow.

## Management API

The UI uses the same HTTP API as any other client. Unprefixed routes remain the v0.1–v0.7 convention. `/api/...` aliases exist for the v0.8 names.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/workflows` | Registered workflow names |
| `GET` | `/api/workflows/:name` | Single workflow |
| `GET` | `/api/runs` | Filtered, paginated run list |
| `GET` | `/api/runs/:id` | Run detail |
| `GET` | `/api/runs/:id/events` | History events (`after`, `limit`) |
| `GET` | `/api/runs/:id/trace` | Hierarchical observability tree |
| `GET` | `/api/runs/:id/graph` | Nodes and edges with layout coordinates |
| `GET` | `/api/runs/:id/logs` | Lightweight run-correlated logs |
| `GET` | `/runs/:id/snapshot?seq=` | Historical state at a history seq |
| `GET` | `/runs/:id/stream` | SSE live history |
| `POST` | `/runs/:id/fork` | Experimental fork from a seq |
| `GET` | `/metrics/overview` | Aggregate operational metrics |

`GET /api/runs` query parameters: `workflow`, `status`, `agent`, `worker`, `from`, `to`, `failed=true`, `minDurationMs`, `maxDurationMs`, `limit`, `offset`.

Authorization is whatever you already attach at the Hono boundary. Local `drassos dev` still has no auth.

## Retention

Observability does not introduce a second store. Retention is the same as durable history: rows live in PGlite/Postgres until you delete them. Payload capture (`disabled` / `metadata-only`) is the control for how much of that history is *exposed*, not a separate TTL.

## Reading the execution graph

`GET /runs/:id/graph` returns `{ nodes, edges }`. Each node has `type`, `status`, `x`, and `y`. The UI renders SVG from those coordinates; other clients can too.

Types: `workflow`, `step`, `activity`, `agent`, `model`, `tool`, `mcp`, `human`, `child`, `timer`, `signal`.

Statuses: `scheduled`, `queued`, `running`, `waiting`, `retrying`, `completed`, `failed`, `cancelled`, `suspended`, `timed_out`.

In the console: drag to pan, wheel or buttons to zoom, click a node to inspect, double-click to collapse children. Child workflow nodes link to the child run.

## Debugging failed workflows

1. Filter the dashboard to `status=FAILED` or Failures only.
2. Open the run. Failed nodes use a red fill; the inspector shows the persisted error.
3. The timeline lists `step.retrying`, `step.failed`, and `workflow.failed` in order.
4. Move the snapshot slider to the seq before the failure to see completed steps, pending timers, and pending human work.

Retries increment `attempt` on the operation. `GET /metrics/overview` exposes `retryRate` and latency percentiles.

## Debugging agents and tool calls

Select an agent node. The inspector shows duration, nested model/tool/MCP children, token counts, and estimated cost when usage is present.

Model calls include provider, model, latency, tokens, and estimated USD using `observability.modelRates` (defaults include `gpt-4o` and `gpt-4o-mini`).

Tool and MCP nodes show arguments/results according to capture policy, plus `server` on MCP calls.

## Live updates

`GET /runs/:id/stream` is Server-Sent Events. The console subscribes and reloads trace/graph/timeline. Named events include `history`, `run.status`, and the underlying history type (`workflow.completed`, `signal.received`, …). The UI reconnects with exponential backoff after a dropped connection.

## Replay / fork

History is immutable. `POST /runs/:id/replay` compares workflow code to recorded history without mutating the original run. `POST /runs/:id/fork` with `{ seq }` copies completed steps up to that event into a **new** run id. See [workflow-evolution.md](workflow-evolution.md) for versioning, export, and compatible workers.

`GET /metrics/overview` also reports replay attempts/successes/divergences, executions waiting for compatible workers, and counts by workflow version.

## OpenTelemetry

Each observable operation has `traceId` (root run id) and `spanId` (operation id). Native OTLP export is deferred; a future exporter can map this hierarchy without changing the execution model.

## Demo

Start `observability-tour` from the console (`topic` plus an optional `secretToken`). The run walks agent → model → tool → child workflow → human approval → writer agent. The secret is redacted in `/trace`.
