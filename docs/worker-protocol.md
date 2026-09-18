# Drassos worker protocol (v1)

Remote workers are HTTP clients. The Drassos server owns durable state; workers do not keep workflow state locally.

Protocol version: `1` (`X-Drassos-Worker-Protocol` or `protocolVersion` in JSON).

Optional auth: `Authorization: Bearer $DRASSOS_WORKER_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/worker/register` | Announce worker id, queues, concurrency, capabilities |
| `POST` | `/worker/heartbeat` | Process liveness, active tasks, available slots |
| `POST` | `/worker/tasks/poll` | Atomically claim leased tasks for the given queues |
| `POST` | `/worker/tasks/:taskId/heartbeat` | Extend the task lease; optional progress |
| `POST` | `/worker/tasks/:taskId/complete` | Persist result (idempotent for the same lease token) |
| `POST` | `/worker/tasks/:taskId/fail` | Retry or dead-letter according to `maxAttempts` |
| `POST` | `/worker/drain` | Mark the worker draining |
| `POST` | `/worker/disconnect` | Mark the worker offline |
| `GET` | `/metrics/queues` | Queue depth, completions, retries, lease expirations |
| `GET` | `/workers` | Worker identity and capacity |

Poll claims use `FOR UPDATE SKIP LOCKED` in PostgreSQL so multiple API instances sharing one database cannot issue two valid leases for the same task.

Use `@drassos/worker` (`DrassosWorker`) or `drassos worker --server http://... --queues agents,tools`.
