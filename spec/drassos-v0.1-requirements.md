# Drassos v0.1 Requirements

**Project:** Drassos  
**Version:** v0.1  
**Status:** Initial Requirements  
**Working description:** A durable orchestration engine for deterministic workflows, AI agents, tools, humans, timers, and external events.

---

## 1. Purpose

Drassos v0.1 must prove the core architectural thesis:

> Drassos can execute long-running TypeScript workflows in which ordinary code, AI agents, tools, human decisions, timers, and external events participate as durable, resumable operations.

The primary goal of v0.1 is **not** feature parity with traditional workflow engines such as Camunda or Temporal. It is to establish a small, coherent runtime architecture that can serve as the foundation for a larger agentic workflow platform.

The defining capability of v0.1 is **durable execution**. A workflow must survive process crashes, worker restarts, long periods of inactivity, and movement between workers without restarting already-completed work unnecessarily.

---

## 2. Goals

Drassos v0.1 must provide:

1. TypeScript-defined workflows.
2. Durable workflow and step execution.
3. Deterministic application-code steps.
4. First-class AI agent steps.
5. First-class tools callable by agents.
6. Human-in-the-loop tasks.
7. Durable timers/sleep.
8. Durable external event waiting.
9. Basic parallel execution.
10. Retry, timeout, cancellation, and idempotency support.
11. Persisted execution history.
12. Worker-based execution separated from the API/runtime coordinator.
13. PostgreSQL-backed state and work dispatch.
14. A minimal HTTP API.
15. A developer CLI.
16. A minimal web console for inspecting workflow runs.

---

## 3. Non-Goals for v0.1

The following are explicitly outside the v0.1 scope:

- BPMN support
- Visual workflow authoring
- DMN/rules engine
- MCP integration
- A2A integration
- Multi-language SDKs
- Multi-tenancy
- Enterprise RBAC
- SSO/SAML/OIDC administration
- Kubernetes-specific deployment infrastructure
- Redis/Kafka/NATS requirements
- Advanced distributed scheduling
- Workflow version migration
- Cron/scheduled workflow definitions
- Advanced compensation/saga framework
- Agent memory framework
- Semantic agent routing
- Subworkflows/child workflows as a first-class feature
- Production-grade secrets management
- Production billing/cost accounting

The architecture should avoid unnecessarily blocking these capabilities, but v0.1 must not implement them merely for future-proofing.

---

## 4. Technology Direction

### 4.1 Primary language

The Drassos v0.1 server/runtime/SDK should be implemented primarily in:

- Node.js
- TypeScript

### 4.2 Persistence

PostgreSQL is the required durable store for v0.1.

PostgreSQL should initially be used for:

- workflow definitions/registrations
- workflow runs
- step runs
- execution history
- human tasks
- external events
- durable timers
- queued work
- leases/worker coordination

The v0.1 implementation should prefer PostgreSQL row locking and `FOR UPDATE SKIP LOCKED` or an equivalent mechanism instead of requiring a separate queue infrastructure.

### 4.3 Frontend

The Drassos Console should use React and TypeScript.

---

## 5. Core Concepts

### 5.1 Workflow Definition

A workflow is a named TypeScript function registered with Drassos.

Example API shape:

```ts
export const customerSupport = workflow(
  "customer-support",
  async (ctx) => {
    const ticket = await ctx.step("load-ticket", () =>
      loadTicket(ctx.input.ticketId)
    );

    const analysis = await ctx.agent("analyze-ticket", {
      agent: supportAgent,
      input: ticket,
    });

    if (analysis.requiresApproval) {
      await ctx.human("approve-response", {
        assignedTo: "support",
        data: analysis,
      });
    }

    return ctx.step("send-response", () =>
      sendResponse(analysis)
    );
  }
);
```

Normal TypeScript control flow should remain usable wherever practical.

### 5.2 Workflow Run

Each invocation of a workflow creates a durable `WorkflowRun`.

At minimum, a workflow run must persist:

- unique ID
- workflow name
- workflow version/identity metadata
- input
- output
- status
- created timestamp
- started timestamp
- completed timestamp
- failure information
- cancellation information
- current execution state

### 5.3 Step Run

Each durable operation creates a persisted `StepRun` or specialized equivalent.

A step run must capture at minimum:

- unique ID
- workflow run ID
- logical step name
- step type
- input
- output
- status
- attempt number
- maximum attempts
- error information
- started/completed timestamps
- timeout configuration
- idempotency metadata where applicable

---

## 6. Workflow Lifecycle

The engine must support at least these workflow states:

```text
PENDING
RUNNING
WAITING
COMPLETED
FAILED
CANCELLED
```

A workflow may enter `WAITING` when it is blocked on a durable condition such as:

- human input
- timer
- external event

A waiting workflow must consume no dedicated worker while waiting.

---

## 7. Durable Execution

Durable execution is the highest-priority v0.1 requirement.

### 7.1 Requirements

The runtime must:

- persist successful durable operation results
- recognize already-completed operations when replaying/resuming a workflow
- return persisted results rather than blindly executing completed operations again
- persist failures and retry attempts
- resume workflows after process restart
- allow a workflow to continue on a different worker
- tolerate workers disappearing while executing work
- recover abandoned work through leases/timeouts or an equivalent mechanism

### 7.2 Execution Semantics

Drassos v0.1 should document its execution semantics as **at-least-once** where external side effects are involved.

Drassos must not claim general exactly-once execution.

The SDK/runtime should provide mechanisms that make idempotent operations straightforward.

### 7.3 Replay Safety

Workflow orchestration code may be re-entered during recovery. Durable operations must therefore be identified consistently enough that Drassos can associate the code's operation with previously persisted execution state.

The implementation must define and document how operation identity is determined.

---

## 8. Deterministic Steps

`ctx.step()` represents ordinary application code executed as a durable operation.

Example:

```ts
const result = await ctx.step(
  "charge-customer",
  {
    retry: {
      maxAttempts: 3,
      backoff: "exponential",
    },
    timeout: "30s",
  },
  async () => payments.charge(...)
);
```

### Required features

A step must support:

- persisted input/output
- persisted errors
- retry policies
- fixed backoff
- exponential backoff
- timeout
- cancellation awareness
- attempt tracking
- idempotency key/configuration

---

## 9. Agent Steps

AI agents are first-class durable operations.

Example conceptual API:

```ts
const result = await ctx.agent("research-company", {
  agent: researchAgent,
  input: company,
});
```

### 9.1 Agent Abstraction

The core runtime must not depend directly on one model provider.

Define an abstraction such as:

```ts
interface AgentProvider {
  execute(request: AgentRequest): Promise<AgentResult>;
}
```

A single reference provider/adapter is sufficient for v0.1.

### 9.2 Persisted Agent Data

Agent execution records should capture, where available:

- provider
- model
- input
- output
- execution status
- messages or message references
- tool calls
- tool results/references
- token/input usage
- token/output usage
- duration
- retry attempts
- errors

Sensitive-data handling should be considered in the schema/API so that future redaction or external storage can be added without redesigning the entire execution model.

---

## 10. Tools

Tools are first-class definitions callable by agents.

Example:

```ts
const searchWeb = tool({
  name: "search-web",
  description: "Search the web",
  input: z.object({
    query: z.string(),
  }),
  execute: async ({ query }) => {
    // implementation
  },
});
```

### Requirements

Tools must have:

- stable name
- description
- typed/validated input schema
- execution function
- persisted invocation record
- persisted result/error
- association with the invoking agent run
- execution timing

For v0.1, tools may be local TypeScript functions.

The tool abstraction should allow future MCP-backed tools without requiring agent APIs to change substantially.

---

## 11. Human-in-the-Loop Tasks

A workflow must be able to suspend execution while waiting for human input.

Example:

```ts
const approval = await ctx.human("approve-refund", {
  title: "Approve customer refund",
  assignedTo: "support",
  data: {
    customer,
    amount,
  },
});
```

### Requirements

Calling `ctx.human()` must:

1. Create a durable human task.
2. Persist the requested data.
3. Transition the workflow to a waiting state when appropriate.
4. Release the worker.
5. Allow an external API/UI action to complete the task.
6. Persist the human response.
7. Resume the workflow.
8. Return the human response to workflow code.

The human task response should support arbitrary JSON-compatible typed data rather than being limited internally to approve/reject.

Basic approval/rejection UI may be provided as the initial console experience.

---

## 12. Durable Timers

The workflow API must support durable sleeping.

Example:

```ts
await ctx.sleep("24h");
```

Requirements:

- timer persisted in PostgreSQL
- worker released while waiting
- timer survives server/worker restart
- workflow becomes eligible to resume after the target time
- duplicate wake-ups must not cause duplicate logical completion

---

## 13. External Events

A workflow must be able to wait for an event supplied by another system.

Example:

```ts
const payment = await ctx.waitForEvent("payment.received");
```

Events must be deliverable through the HTTP API.

Example:

```http
POST /runs/{runId}/events
```

```json
{
  "type": "payment.received",
  "data": {
    "paymentId": "pay_123"
  }
}
```

### Requirements

- events are durable
- events include type and payload
- events are associated with a workflow run
- event delivery wakes an appropriate waiting workflow
- events should not be lost merely because the workflow is not actively executing
- duplicate event handling behavior must be documented

---

## 14. Parallel Execution

Provide a basic orchestration primitive such as:

```ts
const results = await ctx.parallel([
  () => ctx.step("lookup-account", ...),
  () => ctx.step("lookup-orders", ...),
]);
```

v0.1 only requires basic fan-out/fan-in behavior.

Advanced concurrency policies are out of scope.

---

## 15. Cancellation

Workflow runs must be cancellable.

Cancellation must:

- persist cancellation state
- prevent new work from being scheduled for the run
- wake or terminate waiting orchestration appropriately
- expose cancellation state to running steps where practical
- not incorrectly mark already-completed operations as cancelled

Hard termination of arbitrary user code is not required if Node.js cannot safely provide it. Cancellation semantics must be documented.

---

## 16. Execution History

Drassos must maintain an append-oriented execution history sufficient for debugging and auditability.

Example:

```text
09:31:01 workflow.started
09:31:02 step.started       load-order
09:31:02 step.completed     load-order
09:31:03 agent.started      analyze-risk
09:31:06 tool.started       lookup-customer
09:31:07 tool.completed     lookup-customer
09:31:10 agent.completed    analyze-risk
09:31:10 human.created      approve-order
09:31:10 workflow.waiting
14:42:51 human.completed    approve-order
14:42:51 workflow.resumed
14:42:52 step.started       process-order
14:42:53 step.completed     process-order
14:42:53 workflow.completed
```

### Required event categories

At minimum:

- workflow started
- workflow waiting
- workflow resumed
- workflow completed
- workflow failed
- workflow cancelled
- step scheduled/started/completed/failed/retrying
- agent started/completed/failed
- tool started/completed/failed
- human task created/completed
- timer created/fired
- external event received/consumed

The history model should become the foundation for future replay, observability, visualization, auditing, and debugging capabilities.

---

## 17. Worker Architecture

Execution must be separated from the API/runtime coordination layer.

Conceptual architecture:

```text
                 ┌────────────────┐
                 │   Drassos API  │
                 └───────┬────────┘
                         │
                 ┌───────▼────────┐
                 │ Runtime Engine │
                 └───────┬────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
        ┌─────▼─────┐         ┌─────▼─────┐
        │ Worker A  │         │ Worker B  │
        └───────────┘         └───────────┘

                 ┌────────────────┐
                 │   PostgreSQL   │
                 │ state/history  │
                 └────────────────┘
```

### Worker requirements

Workers must:

- register or otherwise indicate availability
- safely claim eligible work
- avoid two healthy workers intentionally processing the same work lease simultaneously
- use leases/heartbeats or equivalent recovery semantics
- allow abandoned work to become eligible again
- execute step and agent work
- persist execution outcomes

Multiple worker processes must be supported in v0.1.

---

## 18. HTTP API

At minimum expose APIs equivalent to:

```text
POST   /workflows/:name/runs
GET    /runs/:id
POST   /runs/:id/cancel
GET    /runs/:id/history

POST   /runs/:id/events

GET    /human-tasks
GET    /human-tasks/:id
POST   /human-tasks/:id/complete
```

### General API requirements

- JSON request/response bodies
- stable IDs
- structured errors
- input validation
- appropriate HTTP status codes
- OpenAPI generation/documentation preferred

Authentication is not required for the initial local-development implementation, but API boundaries should make authentication middleware easy to add later.

---

## 19. CLI

Provide a `drassos` CLI.

Initial commands should include equivalents of:

```bash
drassos dev
drassos worker
drassos workflows
drassos runs
drassos run <workflow>
drassos inspect <run-id>
```

### `drassos dev`

This should provide the easiest local developer experience possible.

The eventual goal is one command that starts:

- Drassos API/runtime
- local worker
- Drassos Console

For v0.1, this may orchestrate multiple local processes internally.

---

## 20. Drassos Console

v0.1 should include a minimal React-based console.

This is an inspection/debugging UI, **not** a visual workflow authoring environment.

### Required screens

#### Workflow Runs

Show recent runs with:

- run ID
- workflow
- status
- start time
- duration

#### Run Detail

Show:

- workflow metadata
- input/output
- status
- execution timeline/tree
- steps
- agents
- tool calls
- human tasks
- timers
- events
- failures/retries

Conceptual display:

```text
Customer Refund                         WAITING

● Start
│
● Load Customer                         42 ms
│
● Analyze Refund                        2.8 sec
│   ├─ lookupOrders                     180 ms
│   └─ lookupRefundHistory              320 ms
│
◉ Approve Refund                        WAITING
│
○ Issue Refund
│
○ Wait for Confirmation
```

#### Human Tasks

Show outstanding human tasks and allow a user to complete them.

A simple JSON response editor plus common approve/reject controls is sufficient for v0.1.

---

## 21. Validation and Type Safety

The TypeScript SDK should favor strong typing.

Schema validation may use a library such as Zod.

Where practical, provide typing for:

- workflow input
- workflow output
- step input/output
- tool input/output
- human task response
- event payloads

Do not sacrifice the initial implementation excessively for perfect compile-time inference. Runtime validation at system boundaries is more important.

---

## 22. Error Handling

Errors must be structured and persisted.

Persist at least:

- error type/name
- message
- stack where available
- attempt
- operation ID
- timestamp

Internal Drassos errors should be distinguishable from user workflow/step errors.

---

## 23. Observability

Full observability infrastructure is out of scope, but v0.1 must expose enough information for debugging.

At minimum:

- structured application logs
- run IDs in relevant log records
- step/operation IDs in relevant log records
- persisted execution durations
- persisted execution history
- agent/tool usage metadata where available

OpenTelemetry integration may be considered later and is not required for v0.1.

---

## 24. Suggested Repository Structure

A monorepo is recommended for v0.1.

Example:

```text
drassos/
  apps/
    api/
    console/
    example/

  packages/
    core/
    runtime/
    sdk-typescript/
    worker/
    persistence-postgres/
    agent-core/
    agent-provider-<reference>/
    cli/

  examples/
    refund-workflow/

  docs/

  package.json
  pnpm-workspace.yaml
```

The exact package split may be simplified during implementation. Avoid creating packages that do not yet provide a meaningful architectural boundary.

---

## 25. Reference Workflow / v0.1 Demo

The primary end-to-end demo should be a **Customer Refund** workflow.

```text
Start
  │
  ▼
Load Customer
  │
  ▼
AI Analyze Refund
  │
  ├── tool → lookupOrders
  │
  ├── tool → lookupRefundHistory
  │
  ▼
Refund > $100?
  │
  ├─ No ───────────────────┐
  │                        │
 Yes                       │
  │                        │
  ▼                        │
Human Approval             │
  │                        │
  ▼                        │
Issue Refund ◄─────────────┘
  │
  ▼
Wait 10 seconds
  │
  ▼
Wait for refund.confirmed event
  │
  ▼
Complete
```

The demo should exercise:

- deterministic step
- agent execution
- multiple tool calls
- conditional branching
- human task
- durable sleep
- external event
- workflow completion
- execution history
- console visualization

---

## 26. Failure/Recovery Demo

The reference workflow must also demonstrate durability.

During automated integration tests and/or a documented manual demo:

1. Start the workflow.
2. Complete one or more steps.
3. Kill the worker process.
4. Restart the worker.
5. Verify completed steps are not logically repeated.
6. Reach human approval.
7. Stop all Drassos application processes while the task is waiting.
8. Restart Drassos.
9. Verify the task is still pending.
10. Complete the task.
11. Allow the timer to begin.
12. Restart the worker during/around the timer wait.
13. Verify the timer still wakes the workflow.
14. Reach the external event wait.
15. Submit `refund.confirmed`.
16. Verify the workflow completes.
17. Verify execution history accurately describes the entire run.

Where a step represents an external side effect, the test must verify the configured idempotency mechanism prevents unintended duplicate effects.

---

## 27. Testing Requirements

### Unit tests

Cover at minimum:

- workflow state transitions
- retry policy calculation
- timeout handling
- operation identity
- event matching
- human task completion
- timer calculation
- serialization/deserialization
- cancellation state

### Integration tests

Use a real PostgreSQL instance/container and verify:

- workflow persistence
- worker claiming
- competing workers
- abandoned lease recovery
- retries
- timers
- events
- human tasks
- agent/tool history

### End-to-end tests

The Customer Refund workflow must have an automated or reproducible end-to-end test covering its complete lifecycle.

### Crash recovery tests

Crash/restart behavior is a release-blocking requirement, not an optional test category.

---

## 28. v0.1 Acceptance Criteria

Drassos v0.1 is complete when all of the following are true:

- A developer can define and register a TypeScript workflow.
- A workflow can be started through the CLI or HTTP API.
- Workflow state survives process restart.
- Completed durable operations are recognized during recovery.
- Multiple worker processes can safely consume work.
- Abandoned work can recover after worker failure.
- Normal code can execute through `ctx.step()`.
- Agent execution works through a provider abstraction.
- Agents can invoke registered tools.
- Tool calls appear in execution history.
- A workflow can suspend for human input without occupying a worker.
- Human input can resume the workflow.
- A workflow can durably sleep.
- A workflow can durably wait for an external event.
- A workflow can be cancelled.
- Basic retries and timeouts function correctly.
- Execution history can reconstruct the meaningful lifecycle of a run.
- The CLI can start and inspect runs.
- The Console can list and inspect runs.
- The Console can display and complete human tasks.
- The Customer Refund reference workflow runs successfully end-to-end.
- The reference workflow survives deliberate worker/application restarts.
- Automated tests cover the critical durability/recovery behavior.

---

## 29. Architectural Principles

Implementation decisions for v0.1 should follow these principles:

### Durable by default

Any operation that may matter to workflow correctness should have explicit durable semantics.

### Agents are workflow participants, not the workflow engine

LLMs should not control persistence, retries, scheduling, or workflow durability. Drassos does.

### Deterministic and nondeterministic work coexist

A workflow should freely combine ordinary application logic with AI-driven decisions.

### Waiting should be cheap

A workflow waiting for a person, timer, or event must not require a worker or Node.js process to remain alive.

### History is a product feature

Execution history is not merely logging. It is durable workflow data and the basis for debugging, replay, visualization, auditing, and future observability.

### Provider independence

The core engine should not be coupled to a specific LLM provider, queue provider, or external tool protocol.

### Minimize infrastructure

PostgreSQL should be sufficient to run a complete v0.1 development deployment.

### Prefer code-first workflows

TypeScript is the workflow authoring environment for v0.1. Do not create a custom workflow language prematurely.

### Keep the first release small

When choosing between a sophisticated feature and proving durability/recovery correctly, choose durability/recovery.

---

## 30. Recommended Implementation Order

A reasonable implementation sequence is:

1. Monorepo/project skeleton.
2. PostgreSQL schema and persistence layer.
3. Workflow registration and `WorkflowRun` model.
4. Worker queue/claim/lease mechanism.
5. `ctx.step()` durable execution.
6. Crash recovery and replay/resume behavior.
7. Retry and timeout policies.
8. Durable timers.
9. External events.
10. Human tasks.
11. Agent provider abstraction.
12. Tool definitions and tool execution history.
13. `ctx.agent()`.
14. Parallel execution.
15. Cancellation.
16. HTTP API completion.
17. CLI.
18. Minimal Console.
19. Customer Refund example.
20. End-to-end crash/recovery test suite.
21. Documentation and v0.1 release packaging.

Durability should be continuously tested during implementation rather than added after all workflow features are complete.

---

## 31. Definition of the v0.1 Thesis

A successful Drassos v0.1 should make the following statement demonstrably true:

> A developer can write a TypeScript workflow combining application code, AI agents, tools, human decisions, timers, and external events; run it across disposable workers; kill and restart the system at arbitrary waiting/execution boundaries; and Drassos will persist, recover, resume, and expose the history of that workflow correctly.

That capability is the foundation on which subsequent Drassos releases should build.
