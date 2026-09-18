# Drassos Execution Semantics (v0.1)

Drassos v0.1 provides **durable execution** for TypeScript workflows. This document is the source of truth for recovery, identity, and side-effect behavior.

## Delivery guarantee

Drassos is **at-least-once** for any operation that can produce an external side effect.

If a worker dies after a side effect has occurred but before the step result is persisted, the step will run again after lease recovery. Drassos does **not** claim exactly-once execution.

To make side effects safe, pass `idempotencyKey` on `ctx.step()` and use that key in the external system.

## Operation identity

Each durable operation is identified by:

```text
(workflowRunId, name, occurrence)
```

- `name` is the string passed to `ctx.step`, `ctx.agent`, `ctx.human`, `ctx.sleep`, or derived for `ctx.waitForEvent("type")` as `event:type`.
- `occurrence` is the 0-based number of times that name has already been used during the current execution of the workflow function.

Replay walks the same TypeScript control flow and therefore produces the same identity sequence, as long as orchestration code does not branch on non-deterministic values **outside** durable operations.

For loops, use a unique name per iteration (`charge-${index}`).

## Replay / resume

When a worker executes a run, it re-enters the workflow function from the beginning.

- Completed operations return their persisted output and do not run their callbacks again.
- Waiting operations (human, timer, event) either complete from persisted state or suspend again.
- `RUNNING` or `RETRYING` operations are retried (at-least-once).

A workflow in `WAITING` holds no worker and does not need a Node.js process to stay alive.

## Timers

`ctx.sleep("10s")` persists a timer row and a delayed work item, then suspends the run.

Wake-up is idempotent: `UPDATE timers SET status = 'fired' WHERE status = 'pending'` only succeeds once. Duplicate delayed work items may exist; run execution leases prevent two healthy workers from executing the same run at the same time.

## External events

`POST /runs/:id/events` always persists the event (unless a `id` delivery key duplicates a previous event for that run).

- If the run is already waiting for that type, it is scheduled to resume.
- If the run has not reached `waitForEvent` yet, the event remains unconsumed and is taken when the wait happens.
- Duplicate **logical** events without a delivery `id` are stored separately and consumed in arrival order. This is intentional: two `payment.received` payloads can satisfy two successive waits.
- Duplicate **deliveries** with the same `id` are stored once.

## Human tasks

`ctx.human()` creates a pending task, suspends the run, and resumes when `POST /human-tasks/:id/complete` stores a JSON response. The response is not limited to approve/reject.

## Cancellation

`POST /runs/:id/cancel`:

- Persists `CANCELLED` and cancellation metadata.
- Cancels pending timers and human tasks.
- Prevents new work from being scheduled for the run.
- Does not rewrite already-completed operations to cancelled.

Running user callbacks are not forcibly killed. Node.js cannot safely terminate arbitrary JavaScript. In-flight `ctx.step()` work is cooperative: the runtime checks cancellation between durable operations and honors `AbortSignal` where a callback observes it. A CPU-bound callback may run to completion; its result is discarded if the run is already cancelled.

Timeouts use the same cooperative model: the runtime fails the step when the timer fires, but the original promise is not cancelled unless the callback uses the abort signal.

## Workers and leases

Workers claim work with PostgreSQL `FOR UPDATE SKIP LOCKED`. Each claimed item has a lease/heartbeat. Abandoned work becomes claimable when the lease expires. A second execution lease on `workflow_runs` prevents two healthy workers from running the same workflow function concurrently.

## History

Execution history is an append-only product log, not an application log file. It is the basis for debugging, the console timeline, and future replay/observability work.
