# Workflow Evolution & Production Safety (v0.9)

Drassos v0.9 versions workflow definitions, binds every execution to the version that created it, and replays recorded history without repeating side effects.

## Versioned workflows

```ts
workflow("order-processing", {
  version: "2.0.0",
  run: async (ctx) => {
    const charged = await ctx.step("charge", () => charge(ctx.input));
    return charged;
  },
});
```

Identity is `name@version`. Multiple versions MAY be registered at once. Duplicate `name@version` registrations fail unless `allowReplace` is set. `enforceVersions` requires `MAJOR.MINOR.PATCH`.

Start by name (default = last registered, or `registry.setDefault`) or pin a version:

```ts
await engine.executor.startRun("order-processing", input);
await engine.executor.startRun("order-processing", input, undefined, { version: "2.0.0" });
```

The selected version is persisted before execution and never changes for that run.

## Deterministic APIs

Use these inside orchestration logic instead of `Date.now()`, `Math.random()`, or `crypto.randomUUID()`:

```ts
ctx.now()
ctx.random()
ctx.uuid()
```

Values are stored in `deterministic_values` and reused on resume and replay.

## Replay

Replay executes workflow code against an exported or copied history. Completed steps, tools, agents, activities, humans, timers, and children return recorded results. User callbacks are not invoked.

```bash
drassos replay <execution-id>
drassos replay <execution-id> --against ./dist/workflows.js
drassos replay execution.json --against ./dist/workflows.js
drassos replay --workflow order-processing --version 1.0.0 --against ./dist/v2.js --json
```

Divergence kinds: `OPERATION_CHANGED`, `OPERATION_ADDED`, `OPERATION_REMOVED`, `ORDER_CHANGED`, `INPUT_CHANGED`, `BRANCH_CHANGED`, `MISSING_HANDLER`, `INCOMPATIBLE_STATE`, `UNKNOWN`.

Replay is read-only. Diagnostic rows go to `replay_records`, never onto the original history.

Export:

```bash
drassos execution export <execution-id> -o history.json
```

Exports include `formatVersion` (currently `1`) and redact secrets. Unsupported formats raise `UnsupportedHistoryFormatError`.

## Worker compatibility

Workers advertise `name@version`. `claimWork` only assigns `execute_run` items whose `workflow_name@workflow_version` is in that list. If no compatible worker is online, the execution waits (`waitType: "compatible-worker"`) instead of failing.

```bash
drassos workflows required
```

lists versions still needed by active executions so old workers can be retired after drain.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/workflows` | Grouped names and versions |
| `GET` | `/workflows/required` | Active executions by version |
| `POST` | `/workflows/:name/runs` | Start; body may include `version` |
| `GET` | `/runs/:id/export` | History bundle |
| `POST` | `/runs/:id/replay` | Replay against a registered version |
| `GET` | `/runs/:id/replays` | Diagnostic replay records |

`/metrics/overview` includes replay counts, executions waiting for compatible workers, and executions/workers by version.

The console run page shows `name@version`, a Replay panel, and jump-to-divergence on the timeline.
