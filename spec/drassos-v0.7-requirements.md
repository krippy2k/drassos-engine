# Drassos v0.7 Requirements
## Distributed Workers + Production Scaling

**Version:** 0.7  
**Status:** Planned  
**Project:** Drassos — Agentic Workflow Engine

---

## 1. Overview

Drassos v0.7 introduces distributed execution and the production-oriented worker infrastructure required to run workflows across multiple processes, machines, containers, or compute environments.

Previous releases establish the functional workflow model:

- **v0.1** — Workflow execution
- **v0.2** — Durable execution
- **v0.3** — Agents + tools
- **v0.4** — Human-in-the-loop + signals
- **v0.5** — Multi-agent orchestration / child workflows
- **v0.6** — MCP + external agent/tool interoperability
- **v0.7** — Distributed workers + production scaling
- **v0.8** — Observability / debugger / UI

The primary goal of v0.7 is to separate **durable orchestration state** from **task execution**.

A Drassos server must be able to coordinate a fleet of independently running workers. Workers pull tasks from named queues, execute them, heartbeat while executing long-running work, and report completion or failure.

Worker failure must not corrupt workflow state or permanently lose work.

---

## 2. Goals

v0.7 MUST provide:

1. Distributed worker processes.
2. Named task queues.
3. Worker polling and task claiming.
4. Time-limited task leases.
5. Worker heartbeats.
6. Automatic recovery from worker failure.
7. Worker identity and capability registration.
8. Worker concurrency controls.
9. At-least-once task execution semantics.
10. Retry behavior across distributed workers.
11. Graceful worker shutdown.
12. Basic queue and worker metrics.
13. Horizontal worker scaling.
14. A stable protocol boundary between the Drassos server and workers.

The architecture SHOULD allow workers to eventually be implemented in languages other than TypeScript without redesigning the orchestration engine.

---

## 3. Non-Goals

The following are explicitly outside the v0.7 scope:

- Full web-based observability UI.
- Workflow visual debugger.
- Kubernetes operator.
- Built-in Kubernetes autoscaler.
- Cloud-specific autoscaling controllers.
- Multi-region consensus.
- Global active-active deployment.
- Exactly-once execution guarantees for external side effects.
- Sophisticated worker placement optimization.
- GPU scheduling.
- Cost-aware scheduling.
- Full multi-tenant resource quotas.
- Cross-region queue replication.

These may be added in later releases.

---

# 4. Architecture

## 4.1 High-Level Architecture

```text
                    ┌─────────────────────┐
                    │     Drassos API     │
                    │   / Control Plane   │
                    └──────────┬──────────┘
                               │
                     ┌─────────▼─────────┐
                     │   Durable Store   │
                     │                   │
                     │ workflow runs     │
                     │ event history     │
                     │ tasks             │
                     │ leases            │
                     │ timers            │
                     │ signals           │
                     └─────────┬─────────┘
                               │
                         Task Queues
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
             ▼                 ▼                 ▼
       ┌───────────┐     ┌───────────┐     ┌───────────┐
       │ Worker A  │     │ Worker B  │     │ Worker C  │
       └───────────┘     └───────────┘     └───────────┘
             │                 │                 │
          Agents             Tools              MCP
          Tools              Agents             Agents
```

The Drassos server owns authoritative durable state.

Workers are replaceable execution nodes.

A worker MUST NOT be required to retain durable workflow state locally.

---

# 5. Task Model

## 5.1 Distributed Task

The engine MUST represent remotely executable work as a durable task.

Example:

```ts
interface DistributedTask {
  id: string;
  workflowRunId: string;

  type: string;
  queue: string;

  payload: unknown;

  status:
    | "pending"
    | "leased"
    | "completed"
    | "failed"
    | "dead";

  attempt: number;
  maxAttempts: number;

  createdAt: Date;
  availableAt: Date;

  lease?: TaskLease;
}
```

The exact internal representation may differ, but equivalent information MUST be available.

---

## 5.2 Task Types

The distributed task infrastructure MUST be generic enough to execute multiple categories of work.

Examples include:

```text
activity
agent
tool
mcp-tool
child-workflow-dispatch
custom
```

The task queue MUST NOT be tightly coupled to LLM execution.

---

# 6. Named Task Queues

Tasks MUST be assigned to named queues.

Example queues:

```text
default
agents
tools
email
payments
gpu
external-api
```

Workflow definitions SHOULD be able to specify a queue.

Example:

```ts
await ctx.activity("process-payment", input, {
  queue: "payments"
});
```

Agent execution SHOULD support the same concept.

```ts
await ctx.agent("research-agent", input, {
  queue: "agents"
});
```

If no queue is specified, Drassos MUST use:

```text
default
```

---

# 7. Worker Runtime

Drassos MUST provide a worker runtime/library.

Example API:

```ts
const worker = new DrassosWorker({
  server: "http://localhost:8080",

  queues: [
    "default",
    "agents"
  ],

  concurrency: 10
});

worker.registerActivity(
  "send-email",
  sendEmail
);

worker.registerAgent(
  "research-agent",
  researchAgent
);

await worker.start();
```

The API is illustrative and MAY change.

---

# 8. Worker Identity

Every worker MUST have a unique worker ID.

Example:

```text
worker-01HXYZ...
```

Workers SHOULD also advertise metadata.

Example:

```ts
interface WorkerMetadata {
  id: string;

  hostname?: string;
  processId?: number;

  version?: string;

  queues: string[];

  capabilities?: string[];

  concurrency: number;

  startedAt: Date;
}
```

Workers MAY optionally specify a human-readable name.

Example:

```text
agent-worker-us-east-1
```

---

# 9. Worker Capabilities

Workers SHOULD be able to advertise capabilities.

Example:

```json
{
  "queues": ["agents"],
  "capabilities": [
    "openai",
    "anthropic",
    "browser",
    "mcp"
  ]
}
```

Capability metadata is primarily intended for future scheduling improvements.

v0.7 MAY use capabilities for basic compatibility filtering.

The design MUST NOT require sophisticated placement logic.

---

# 10. Worker Registration

When a worker starts, it MUST register or announce itself to the Drassos server.

Registration SHOULD include:

```text
worker ID
worker version
queues
capabilities
concurrency
startup timestamp
```

The server MUST track the last time it heard from each worker.

Workers that have not communicated within a configurable timeout SHOULD eventually be considered unavailable.

Worker registration MUST NOT make task correctness depend on the worker remaining registered.

Task leases are the authoritative mechanism for recovering abandoned work.

---

# 11. Worker Polling

Workers MUST pull work from Drassos.

The server MUST NOT require direct network connectivity from the server to each worker.

Conceptually:

```text
Worker
  │
  │ poll(queue)
  ▼
Drassos
  │
  │ task + lease
  ▼
Worker
```

This allows workers to run behind NAT, inside private networks, or in independently scaled container environments.

---

# 12. Polling Behavior

Workers SHOULD support long polling.

Example conceptual request:

```http
POST /worker/tasks/poll
```

Request:

```json
{
  "workerId": "worker-123",
  "queues": ["agents"],
  "availableSlots": 4
}
```

Response:

```json
{
  "tasks": [
    {
      "id": "task-456",
      "type": "agent",
      "name": "research-agent",
      "payload": {},
      "leaseToken": "...",
      "leaseExpiresAt": "..."
    }
  ]
}
```

The transport MAY use HTTP initially.

The worker protocol SHOULD be designed so another transport could be introduced later.

---

# 13. Task Leasing

Polling MUST atomically claim tasks.

When a task is assigned to a worker, Drassos MUST create a lease.

Example:

```ts
interface TaskLease {
  workerId: string;

  token: string;

  acquiredAt: Date;
  expiresAt: Date;
}
```

A task MUST NOT have multiple active valid leases simultaneously.

---

# 14. Lease Tokens

Each task lease MUST have an opaque lease token.

Completion, failure, heartbeat, or lease extension requests MUST provide the token.

Example:

```json
{
  "taskId": "task-456",
  "leaseToken": "..."
}
```

This prevents a stale worker from completing a task after ownership has transferred to another worker.

---

# 15. Lease Expiration

If a worker stops heartbeating and its lease expires:

```text
leased
   │
   │ lease timeout
   ▼
pending
```

The task MUST become eligible for another worker.

The workflow MUST NOT require manual intervention.

---

# 16. Heartbeats

Workers MUST support task heartbeats for long-running work.

Example:

```ts
await task.heartbeat();
```

The worker runtime SHOULD automatically heartbeat active tasks.

Tasks MAY additionally provide progress information.

Example:

```ts
await task.heartbeat({
  progress: 0.45,
  message: "Analyzing documents"
});
```

Progress metadata is optional and SHOULD NOT affect execution correctness.

---

# 17. Worker Heartbeats

The worker itself SHOULD periodically heartbeat with the server independently of individual task heartbeats.

This provides operational information such as:

```text
worker online/offline status
active task count
available capacity
worker version
```

Worker heartbeats MUST NOT replace task leases.

---

# 18. Task Completion

Workers MUST explicitly report successful task completion.

Example:

```http
POST /worker/tasks/:taskId/complete
```

Payload:

```json
{
  "workerId": "worker-123",
  "leaseToken": "...",
  "result": {}
}
```

The server MUST verify that:

1. the task exists;
2. the lease token is valid;
3. the lease has not been superseded;
4. the task has not already reached an incompatible terminal state.

Completion MUST be persisted before dependent workflow work becomes runnable.

---

# 19. Task Failure

Workers MUST explicitly report task failures.

Example:

```json
{
  "workerId": "worker-123",
  "leaseToken": "...",
  "error": {
    "type": "ExternalApiError",
    "message": "Service unavailable",
    "retryable": true
  }
}
```

Failure handling MUST integrate with the durable retry behavior established in earlier Drassos releases.

---

# 20. At-Least-Once Execution

Drassos v0.7 MUST explicitly define distributed task execution as:

```text
at-least-once
```

Example failure:

```text
Worker executes payment
        │
        ▼
Payment succeeds
        │
        ▼
Worker crashes
        │
        X
Completion never reaches Drassos
        │
        ▼
Lease expires
        │
        ▼
Task executes again
```

Drassos MUST NOT claim exactly-once execution for external side effects.

---

# 21. Idempotency

The worker SDK SHOULD expose an idempotency key for every task execution.

Example:

```ts
ctx.idempotencyKey
```

A stable value SHOULD be available across retries of the same logical task.

Example:

```ts
await paymentProvider.charge({
  amount: 100,
  idempotencyKey: ctx.idempotencyKey
});
```

Documentation MUST explain that side-effecting tools and activities SHOULD be idempotent whenever possible.

---

# 22. Retry Behavior

Distributed task failures MUST honor configured retry policies.

Example:

```ts
{
  maxAttempts: 5,
  initialDelay: "1s",
  backoff: 2,
  maxDelay: "1m"
}
```

Retries MAY execute on a different worker.

Example:

```text
Attempt 1 → Worker A → failure
Attempt 2 → Worker C → failure
Attempt 3 → Worker B → success
```

Workflow correctness MUST NOT depend on retrying on the same worker.

---

# 23. Worker Failure Recovery

Drassos MUST recover automatically when a worker process disappears.

Required scenario:

```text
Worker A claims Task X
        │
        ▼
Worker A crashes
        │
        ▼
heartbeat stops
        │
        ▼
lease expires
        │
        ▼
Task X becomes available
        │
        ▼
Worker B claims Task X
```

No administrator action MUST be required.

---

# 24. Stale Worker Protection

Consider:

```text
Worker A claims Task X
Worker A loses network
lease expires
Worker B claims Task X
Worker A reconnects
Worker A attempts completion
```

Drassos MUST reject Worker A's stale completion.

The lease token or equivalent fencing mechanism MUST ensure only the current task owner can modify the task's active execution state.

---

# 25. Worker Concurrency

Workers MUST support configurable maximum concurrency.

Example:

```ts
new DrassosWorker({
  concurrency: 20
});
```

The worker MUST NOT intentionally execute more than the configured number of tasks simultaneously.

Polling SHOULD account for available worker capacity.

Example:

```text
concurrency = 20
active = 17
availableSlots = 3
```

The worker SHOULD request no more than three new tasks.

---

# 26. Per-Queue Concurrency

The worker runtime SHOULD support optional per-queue concurrency.

Example:

```ts
{
  concurrency: 20,

  queues: {
    agents: {
      concurrency: 5
    },

    tools: {
      concurrency: 15
    }
  }
}
```

This feature is desirable but MAY be deferred if it substantially increases v0.7 complexity.

---

# 27. Backpressure

The worker system MUST provide natural backpressure.

If:

```text
incoming task rate > worker processing rate
```

tasks MUST remain durably queued rather than being pushed into worker memory without bound.

Adding workers SHOULD increase processing capacity without requiring workflow changes.

---

# 28. Graceful Shutdown

Workers MUST support graceful shutdown.

Example:

```text
SIGTERM
   │
   ▼
stop polling
   │
   ▼
finish active work
   │
   ▼
report results
   │
   ▼
exit
```

A configurable shutdown timeout SHOULD be supported.

Example:

```ts
{
  shutdownTimeout: "30s"
}
```

When the timeout expires, unfinished tasks MAY be abandoned and recovered through lease expiration.

---

# 29. Worker Drain Mode

The worker runtime SHOULD expose an explicit drain operation.

Example:

```ts
await worker.drain();
```

Drain mode MUST:

1. stop accepting new tasks;
2. continue existing tasks;
3. wait until active task count reaches zero or a timeout occurs.

This is useful for rolling deployments.

---

# 30. Queue Fairness

Workers polling multiple queues SHOULD avoid permanently starving one queue.

A simple fair scheduling strategy is sufficient for v0.7.

Advanced priority scheduling is not required.

---

# 31. Task Priority

Basic task priority MAY be implemented.

Example:

```ts
{
  priority: 10
}
```

If implemented, higher-priority tasks SHOULD be selected before lower-priority tasks within the same queue.

Priority MUST NOT compromise durable task ordering or leasing correctness.

Priority is optional for v0.7.

---

# 32. Dead-Letter / Terminal Failure

Tasks that exhaust their retry policy MUST enter a durable terminal state.

Example:

```text
dead
```

The task record MUST preserve:

```text
task ID
workflow run ID
attempt count
last error
timestamps
queue
task type
```

The workflow engine MUST receive the terminal failure and apply the workflow's normal failure semantics.

A separate external dead-letter queue implementation is NOT required.

---

# 33. Server Restart Recovery

Distributed execution MUST survive Drassos server restarts.

After restart:

- pending tasks MUST remain pending;
- completed tasks MUST remain completed;
- retry schedules MUST remain intact;
- active leases MUST either remain valid or safely expire;
- workers MUST be able to reconnect and resume polling.

No task may disappear solely because the Drassos server restarted.

---

# 34. Multiple Drassos Server Instances

The task claim mechanism SHOULD be designed to work correctly when multiple Drassos server/API instances access the same durable store.

Example:

```text
                 Load Balancer
                 /           \
                /             \
        Drassos API A      Drassos API B
                \             /
                 \           /
                  Durable DB
```

Task claiming MUST be atomic at the durable-store level.

Two API instances MUST NOT successfully issue simultaneous valid leases for the same task.

Full distributed control-plane coordination is not required beyond the consistency needed for task leasing.

---

# 35. Worker Protocol

The worker/server communication contract MUST be treated as a versioned protocol boundary.

At minimum it MUST support operations equivalent to:

```text
register worker
worker heartbeat
poll tasks
task heartbeat
complete task
fail task
drain/disconnect worker
```

The protocol SHOULD include a protocol version.

Example:

```json
{
  "protocolVersion": "1"
}
```

---

# 36. Protocol Compatibility

Workers SHOULD advertise:

```text
worker SDK version
protocol version
```

The server MUST reject clearly incompatible protocol versions with an actionable error.

The design SHOULD eventually allow:

```text
TypeScript worker
Python worker
Go worker
Rust worker
.NET worker
```

Only the TypeScript worker SDK is required for v0.7.

---

# 37. Authentication

Remote workers MUST authenticate with the Drassos server in production deployments.

The initial implementation MAY use API keys or worker tokens.

Example:

```http
Authorization: Bearer <worker-token>
```

Credentials MUST NOT be persisted in workflow history or logs.

Fine-grained worker authorization MAY be deferred, but the architecture SHOULD allow future restrictions such as:

```text
worker X may poll queue agents
worker Y may poll queue payments
```

---

# 38. Transport Security

Production documentation MUST recommend TLS for remote worker connections.

Drassos MUST NOT invent its own encryption protocol.

---

# 39. Queue Metrics

The server MUST expose basic queue metrics.

At minimum:

```text
pending task count
leased task count
oldest pending task age
task completion count
task failure count
retry count
lease expiration count
```

Metrics MAY initially be exposed programmatically rather than through a UI.

---

# 40. Worker Metrics

Drassos SHOULD expose:

```text
worker ID
worker status
queues
capabilities
active tasks
configured concurrency
available capacity
last heartbeat
worker version
```

This data will become an input to the v0.8 observability UI.

---

# 41. Execution Metrics

The system SHOULD make it possible to measure:

```text
queue wait duration
task execution duration
attempt count
retry delay
lease duration
```

The instrumentation model SHOULD avoid requiring a breaking redesign in v0.8.

---

# 42. Logging

Worker logs SHOULD include structured identifiers:

```text
workerId
taskId
workflowRunId
queue
attempt
taskType
```

Example:

```json
{
  "level": "info",
  "message": "Task completed",
  "workerId": "worker-123",
  "taskId": "task-456",
  "workflowRunId": "run-789",
  "queue": "agents",
  "attempt": 2
}
```

Secrets and sensitive task payloads MUST NOT be logged by default.

---

# 43. Horizontal Scaling

Drassos MUST support multiple workers polling the same queue.

Example:

```text
agents queue
    │
    ├── Worker A
    ├── Worker B
    ├── Worker C
    └── Worker D
```

Tasks SHOULD naturally distribute across available workers.

Adding or removing workers MUST NOT require changing workflow definitions.

---

# 44. Autoscaling Compatibility

Drassos does NOT need to implement an autoscaler in v0.7.

However, it SHOULD expose enough metrics for external systems to autoscale workers.

Useful signals include:

```text
queue depth
oldest task age
active worker count
available worker capacity
task arrival rate
```

This SHOULD make future integrations with Kubernetes, ECS, Nomad, or cloud-specific scaling systems straightforward.

---

# 45. Deployment Model

The following deployment MUST be supported:

```text
Drassos Server
PostgreSQL
Worker Process A
Worker Process B
Worker Process C
```

Workers MAY run:

```text
locally
Docker containers
VMs
Kubernetes pods
ECS tasks
independent hosts
```

The worker runtime MUST NOT depend on a shared filesystem.

---

# 46. Development Mode

Local development SHOULD remain simple.

Example:

```bash
npm run drassos-server
npm run worker
```

A developer MUST NOT need Kubernetes or another distributed platform to test worker behavior.

Multiple workers SHOULD be runnable locally as separate processes.

---

# 47. Failure Injection Testing

The test suite MUST intentionally exercise failure scenarios.

Required scenarios include:

### Worker crash

```text
claim task
kill worker
wait for lease expiration
verify another worker executes task
```

### Server restart

```text
queue tasks
restart Drassos server
verify tasks remain available
```

### Network interruption

```text
worker claims task
worker loses connection
lease expires
another worker claims task
old worker attempts completion
verify stale completion rejected
```

### Duplicate completion

```text
worker submits completion twice
verify workflow state changes once
```

### Concurrent polling

```text
multiple workers poll simultaneously
verify a task receives only one valid active lease
```

---

# 48. Performance Requirements

v0.7 is not intended to establish final production-scale performance targets.

However, the architecture MUST avoid obvious single-worker assumptions.

The implementation SHOULD support at least:

```text
10+ simultaneous worker processes
100+ concurrently executing tasks
thousands of queued tasks
```

during integration testing on ordinary development infrastructure.

These numbers are engineering validation targets rather than formal service guarantees.

---

# 49. Persistence Requirements

The durable store MUST persist enough information to reconstruct distributed task state after process failure.

This includes:

```text
task
queue
status
attempt
retry timing
lease owner
lease token/fencing information
lease expiration
result or failure
timestamps
```

Task claiming MUST use transactions, conditional updates, locking, or an equivalent atomic persistence mechanism.

---

# 50. Security Requirements

The implementation MUST:

- authenticate production workers;
- validate worker protocol messages;
- treat lease tokens as opaque credentials;
- avoid logging credentials;
- reject stale lease operations;
- validate task payload size;
- enforce reasonable request limits;
- avoid trusting worker-provided workflow identifiers without verification.

A compromised worker SHOULD NOT be able to arbitrarily mutate unrelated workflow state through the worker protocol.

---

# 51. Compatibility With Agents and Tools

Agents introduced in v0.3 MUST be executable through distributed workers.

Tools MUST also be executable through distributed workers where appropriate.

Example:

```text
Workflow
   │
   ▼
Agent Task
   │
   ▼
agents queue
   │
   ▼
Agent Worker
   │
   ├── LLM
   ├── Tool
   └── MCP
```

The worker infrastructure MUST remain generic enough that an agent is simply one kind of executable task.

---

# 52. Compatibility With Child Workflows

Child workflows introduced in v0.5 MUST remain durable when their execution spans distributed workers.

A parent workflow MUST NOT depend on a particular worker executing its child workflow.

---

# 53. Compatibility With MCP

MCP functionality introduced in v0.6 MUST be usable from remote workers.

Example:

```text
Drassos
   │
   ▼
Agent Task
   │
   ▼
Worker
   │
   ▼
MCP Client
   │
   ▼
External MCP Server
```

MCP connections SHOULD normally belong to the worker performing the task rather than the central orchestration server when execution is worker-local.

---

# 54. Public SDK Surface

A minimal TypeScript API might resemble:

```ts
import { DrassosWorker } from "@drassos/worker";

const worker = new DrassosWorker({
  server: process.env.DRASSOS_SERVER!,
  token: process.env.DRASSOS_WORKER_TOKEN!,

  queues: ["default", "agents"],

  concurrency: 10
});

worker.activity("send-email", async (ctx, input) => {
  // ...
});

worker.agent("research-agent", async (ctx, input) => {
  // ...
});

await worker.start();
```

Exact package names and APIs MAY change.

The final API SHOULD prioritize simplicity for the common worker use case.

---

# 55. Suggested Package Structure

One possible organization:

```text
packages/
  core/
  server/
  worker/
  worker-protocol/
```

For example:

```text
@drassos/core
@drassos/server
@drassos/worker
@drassos/worker-protocol
```

The protocol package SHOULD avoid unnecessary dependencies on server internals.

---

# 56. Required Integration Demo

v0.7 MUST include a distributed execution demo.

The demo MUST run:

```text
1 Drassos server
3 worker processes
1 durable database
```

The workflow SHOULD contain multiple distributed tasks.

Example:

```text
Start
  │
  ▼
Agent Task ───────────────► Worker A
  │
  ▼
Tool Task ────────────────► Worker B
  │
  ▼
Long Agent Task ──────────► Worker C
                               │
                               X kill Worker C
                               │
                         lease expires
                               │
                               ▼
                            Worker A
                               │
                               ▼
                           Complete
```

The test MUST intentionally terminate the worker executing the long-running task.

The workflow MUST recover and complete without manual intervention.

---

# 57. Acceptance Criteria

v0.7 is complete when all of the following are true:

### Distributed execution

- [ ] Workers run as independent processes.
- [ ] Workers can execute tasks without sharing memory with the Drassos server.
- [ ] Multiple workers can execute tasks concurrently.

### Queues

- [ ] Tasks can target named queues.
- [ ] Workers can subscribe to named queues.
- [ ] Multiple workers can poll the same queue.
- [ ] Unhandled tasks remain durably queued.

### Leasing

- [ ] Task claims are atomic.
- [ ] Claimed tasks receive leases.
- [ ] Leases expire.
- [ ] Lease tokens prevent stale completion.
- [ ] Expired tasks can be reclaimed.

### Failure recovery

- [ ] Killing a worker does not lose its tasks.
- [ ] Another worker can recover abandoned work.
- [ ] Server restart does not lose queued work.
- [ ] Stale workers cannot overwrite newer execution state.

### Reliability

- [ ] At-least-once semantics are documented.
- [ ] Stable idempotency keys are available.
- [ ] Retry policies work across workers.
- [ ] Exhausted tasks reach a durable terminal failure state.

### Capacity

- [ ] Worker concurrency is configurable.
- [ ] Polling respects available worker capacity.
- [ ] Queues provide backpressure.
- [ ] Workers support graceful shutdown.

### Operations

- [ ] Worker identity is visible.
- [ ] Worker heartbeat/status information is available.
- [ ] Queue depth is measurable.
- [ ] Queue wait time can be measured.
- [ ] Lease expiration and retry counts are measurable.

### Security

- [ ] Production workers can authenticate.
- [ ] Lease operations are validated.
- [ ] Worker credentials are not logged.
- [ ] Worker APIs cannot directly mutate arbitrary workflow state.

### Protocol

- [ ] Worker/server communication uses a documented protocol.
- [ ] Protocol versioning exists.
- [ ] Protocol implementation is sufficiently decoupled to support future non-TypeScript workers.

---

# 58. Test Checklist

## Basic execution

- [ ] Start server.
- [ ] Start one worker.
- [ ] Submit workflow.
- [ ] Worker receives task.
- [ ] Worker completes task.
- [ ] Workflow completes.

## Multiple workers

- [ ] Start three workers.
- [ ] Queue multiple tasks.
- [ ] Verify tasks execute across workers.
- [ ] Verify concurrency limits are respected.

## Queue routing

- [ ] Start `agents` worker.
- [ ] Start `payments` worker.
- [ ] Queue agent task.
- [ ] Verify only appropriate worker executes it.
- [ ] Queue payment task.
- [ ] Verify correct queue routing.

## Worker crash

- [ ] Worker claims task.
- [ ] Kill worker.
- [ ] Wait for lease expiration.
- [ ] Verify second worker claims task.
- [ ] Verify workflow completes.

## Stale completion

- [ ] Worker A claims task.
- [ ] Cause Worker A to lose connectivity.
- [ ] Allow lease to expire.
- [ ] Worker B claims task.
- [ ] Worker A attempts completion.
- [ ] Verify completion is rejected.

## Retries

- [ ] Fail task intentionally.
- [ ] Verify retry attempt increments.
- [ ] Verify retry can execute on another worker.
- [ ] Exhaust retry limit.
- [ ] Verify durable terminal failure.

## Server restart

- [ ] Queue work.
- [ ] Restart server.
- [ ] Verify pending work remains.
- [ ] Verify workers reconnect.
- [ ] Verify workflow eventually completes.

## Graceful shutdown

- [ ] Worker has active tasks.
- [ ] Trigger drain/shutdown.
- [ ] Verify no new tasks are accepted.
- [ ] Verify existing tasks finish.
- [ ] Verify worker exits cleanly.

## Load

- [ ] Queue thousands of tasks.
- [ ] Start multiple workers.
- [ ] Verify no duplicate active leases.
- [ ] Verify no lost tasks.
- [ ] Verify queue drains.
- [ ] Verify metrics remain accurate.

---

# 59. Definition of Done

Drassos v0.7 is considered complete when a workflow can execute across a fleet of independent worker processes and continue making progress despite worker or server process failures.

The defining demonstration is:

> Start a workflow across several workers, terminate one of those workers while it owns active work, and observe Drassos automatically recover the abandoned task on another worker and complete the workflow without manual intervention or corrupted durable state.

At that point, Drassos has moved from a durable agentic workflow engine to a horizontally scalable distributed execution platform.

The next release, **v0.8**, can build the observability, debugging, and visualization layer on top of the worker, queue, lease, retry, and execution telemetry established here.
