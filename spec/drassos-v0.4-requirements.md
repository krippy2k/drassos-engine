# Drassos v0.4 Requirements

**Version:** 0.4\
**Milestone:** Human-in-the-Loop + Signals\
**Status:** Planned

## 1. Overview

Drassos v0.4 adds durable external interaction to the workflow engine.

After v0.3, workflows can execute agents and tools. v0.4 must allow a
running workflow to suspend while waiting for an external event or human
decision, survive process restarts while suspended, and resume
deterministically when the event arrives.

The central primitive for v0.4 is the **signal**. Human approval is
implemented as a higher-level abstraction built on top of signals and
durable workflow state.

The core guarantee is:

> A workflow may wait for an external event for seconds, hours, days, or
> longer without occupying a worker, and may resume correctly even if
> Drassos has restarted since the wait began.

------------------------------------------------------------------------

## 2. Goals

v0.4 must provide:

-   Durable workflow signals.
-   Durable waiting for signals.
-   External APIs for delivering signals.
-   Human-in-the-loop approval/review steps.
-   Approve, reject, and request-changes outcomes.
-   Durable timeouts for signal waits and human interactions.
-   Queryable pending interactions.
-   Complete workflow history for signals and human interactions.
-   Deterministic replay of workflows containing signal waits.
-   Correct behavior across process crashes and restarts.

------------------------------------------------------------------------

## 3. Non-Goals

The following are explicitly outside v0.4:

-   Multi-agent orchestration.
-   Child workflows.
-   MCP integration.
-   A2A interoperability.
-   Distributed worker execution.
-   Production clustering.
-   Full graphical workflow UI.
-   Full human task-management application.
-   User authentication/authorization system.
-   Email/SMS notification delivery.
-   Complex organizational approval policies.

These may build on the v0.4 primitives in later releases.

------------------------------------------------------------------------

## 4. Terminology

### Signal

A named external event delivered to a workflow execution.

A signal consists of:

``` ts
interface WorkflowSignal<T = unknown> {
  name: string;
  payload: T;
}
```

Examples:

-   `approval`
-   `payment-received`
-   `user-response`
-   `cancel`
-   `inventory-updated`

### Signal Wait

A durable workflow operation that suspends execution until a matching
signal arrives or an optional timeout occurs.

### Human Interaction

A durable request for human input associated with a workflow execution.

### Human Decision

The response completing a human interaction.

``` ts
type HumanDecision<T = unknown> =
  | {
      outcome: "approved";
      data?: T;
    }
  | {
      outcome: "rejected";
      reason?: string;
    }
  | {
      outcome: "changes_requested";
      feedback: string;
      data?: T;
    };
```

------------------------------------------------------------------------

## 5. Functional Requirements

## 5.1 Signals

Drassos MUST support delivering named signals to running workflow
executions.

Example:

``` ts
await client.signal(workflowId, "approval", {
  approved: true,
  approvedBy: "user-123",
});
```

A signal MUST contain:

-   Target workflow execution.
-   Signal name.
-   Payload.
-   Unique signal/event identifier.
-   Timestamp.

Signal payloads MUST support JSON-serializable values.

The API SHOULD support TypeScript generic typing:

``` ts
await client.signal<ApprovalPayload>(
  workflowId,
  "approval",
  payload
);
```

### Signal durability

Signals MUST be persisted before they are considered accepted.

Once the signal API reports success, the signal MUST survive:

-   Worker crashes.
-   Drassos process crashes.
-   Engine restarts.
-   Workflow suspension.
-   Temporary absence of an executing worker.

------------------------------------------------------------------------

## 5.2 Waiting for Signals

Workflow code MUST be able to wait for a named signal:

``` ts
const approval =
  await ctx.waitForSignal<ApprovalPayload>("approval");
```

If no matching signal is available, the workflow MUST transition into a
durable waiting state.

Waiting MUST NOT require a worker or workflow function to remain
resident in memory.

The workflow SHOULD expose a state such as:

``` text
WAITING
```

with metadata indicating what it is waiting for.

Example:

``` json
{
  "status": "WAITING",
  "waitingFor": {
    "type": "signal",
    "name": "approval"
  }
}
```

When the matching signal arrives, Drassos MUST schedule the workflow for
continuation.

------------------------------------------------------------------------

## 5.3 Signal Buffering

Drassos MUST define deterministic behavior when a signal arrives before
the workflow reaches its corresponding wait.

The preferred behavior is to buffer the signal in durable workflow
history.

Example:

``` text
signal arrives
      ↓
signal persisted
      ↓
workflow reaches waitForSignal("approval")
      ↓
existing signal consumed
      ↓
workflow continues immediately
```

Signals MUST NOT be silently discarded merely because the workflow is
not currently waiting for them.

Each signal MUST be consumed at most once unless an API explicitly
implements broadcast semantics in a future version.

------------------------------------------------------------------------

## 5.4 Signal Ordering

Signals for a workflow MUST have deterministic ordering.

When multiple signals with the same name are pending, `waitForSignal()`
MUST consume them in recorded workflow-history order.

Example:

``` text
Signal A
Signal B
Signal C

await waitForSignal("message") -> A
await waitForSignal("message") -> B
await waitForSignal("message") -> C
```

------------------------------------------------------------------------

## 5.5 Signal Idempotency

The signal delivery API SHOULD support an idempotency key or unique
signal ID.

Example:

``` ts
await client.signal(workflowId, "approval", payload, {
  id: "signal-abc123",
});
```

Delivering the same signal ID more than once MUST NOT cause the workflow
to consume the logical signal multiple times.

------------------------------------------------------------------------

## 5.6 Signal Timeouts

Signal waits MUST support optional durable timeouts.

Example:

``` ts
const approval = await ctx.waitForSignal("approval", {
  timeout: "24h",
});
```

The timeout MUST use the durable timer infrastructure introduced in
earlier Drassos versions.

A timeout MUST survive process restarts.

The API MUST clearly distinguish:

-   Signal received.
-   Wait timed out.

One acceptable API is:

``` ts
const result = await ctx.waitForSignal("approval", {
  timeout: "24h",
});

if (result.timedOut) {
  // escalation/fallback
}
```

Alternatively, Drassos MAY use a typed timeout exception if that matches
the existing workflow API more naturally.

------------------------------------------------------------------------

## 5.7 Human Approval

Drassos MUST provide a higher-level human interaction abstraction.

Example:

``` ts
const decision = await ctx.approval({
  id: "publish-report",
  title: "Publish generated report?",
  description: "Review the generated report before publishing.",
});
```

The approval call MUST:

1.  Create a durable human interaction.
2.  Suspend the workflow.
3.  Expose the interaction through query APIs.
4.  Wait without occupying a worker.
5.  Resume when the interaction is completed.
6.  Return the human decision to workflow code.

Human approvals SHOULD be implemented using the underlying signal/event
infrastructure rather than a separate execution architecture.

------------------------------------------------------------------------

## 5.8 Human Interaction Definition

A human interaction SHOULD contain:

``` ts
interface HumanInteraction {
  id: string;
  workflowId: string;
  type: "approval";
  title: string;
  description?: string;
  status: HumanInteractionStatus;
  createdAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

type HumanInteractionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "timed_out"
  | "cancelled";
```

The design SHOULD permit additional interaction types in future versions
without redesigning the persistence model.

Possible future types include:

-   Free-form input.
-   Form submission.
-   Choice selection.
-   File review.
-   Credential request.

Only approval/review behavior is required in v0.4.

------------------------------------------------------------------------

## 5.9 Completing Human Interactions

The client API MUST support completing a human interaction.

Example:

``` ts
await client.completeInteraction(
  workflowId,
  "publish-report",
  {
    outcome: "approved",
  }
);
```

Requesting changes:

``` ts
await client.completeInteraction(
  workflowId,
  "publish-report",
  {
    outcome: "changes_requested",
    feedback: "Add citations to the final section.",
  }
);
```

Rejecting:

``` ts
await client.completeInteraction(
  workflowId,
  "publish-report",
  {
    outcome: "rejected",
    reason: "Report contains unsupported conclusions.",
  }
);
```

An interaction MUST only be completed once.

Repeated completion attempts MUST either:

-   Return the existing result when idempotent, or
-   Return a well-defined already-completed error.

They MUST NOT cause duplicate workflow progression.

------------------------------------------------------------------------

## 5.10 Human Interaction Timeouts

Human interactions MUST optionally support timeouts.

Example:

``` ts
const decision = await ctx.approval({
  id: "publish-report",
  title: "Publish report?",
  timeout: "48h",
});
```

If the timeout expires:

-   The interaction MUST become `timed_out`.
-   The workflow MUST become runnable.
-   Workflow code MUST be able to distinguish timeout from a human
    decision.

This allows workflows to implement:

-   Escalation.
-   Automatic rejection.
-   Automatic approval.
-   Retry.
-   Alternative reviewers.
-   Cancellation.

Policy behavior itself belongs in workflow code.

------------------------------------------------------------------------

## 5.11 Pending Interaction Queries

The client MUST expose pending human interactions.

Example:

``` ts
const interactions =
  await client.getPendingInteractions(workflowId);
```

Example response:

``` json
[
  {
    "id": "publish-report",
    "workflowId": "workflow-123",
    "type": "approval",
    "title": "Publish generated report?",
    "status": "pending",
    "createdAt": "2026-09-18T15:00:00Z"
  }
]
```

Drassos SHOULD also support retrieving an individual interaction.

``` ts
await client.getInteraction(
  workflowId,
  "publish-report"
);
```

A simple API for listing pending interactions across workflow executions
MAY be included if it fits the current storage architecture:

``` ts
await client.listPendingInteractions();
```

A full human-task inbox is not required.

------------------------------------------------------------------------

## 5.12 HTTP Signal API

Drassos MUST expose an HTTP endpoint capable of signaling a workflow.

Suggested route:

``` text
POST /workflows/:workflowId/signals/:signalName
```

Example body:

``` json
{
  "id": "signal-abc123",
  "payload": {
    "approved": true
  }
}
```

Successful delivery SHOULD return an accepted/success response only
after the signal has been durably persisted.

The endpoint MUST return meaningful errors for:

-   Unknown workflow.
-   Invalid signal name.
-   Invalid payload.
-   Duplicate signal ID where applicable.
-   Workflow already completed.
-   Workflow failed/cancelled where signaling is not allowed.

------------------------------------------------------------------------

## 5.13 HTTP Human Interaction API

Drassos SHOULD expose minimal HTTP APIs for human interactions.

Suggested routes:

``` text
GET /workflows/:workflowId/interactions
GET /workflows/:workflowId/interactions/:interactionId

POST /workflows/:workflowId/interactions/:interactionId/complete
```

Example completion request:

``` json
{
  "outcome": "approved"
}
```

or:

``` json
{
  "outcome": "changes_requested",
  "feedback": "Please revise the summary."
}
```

These APIs are intended to enable a future Drassos UI or external
application to implement approval screens.

Authentication and authorization are outside the scope of v0.4.

------------------------------------------------------------------------

## 6. Workflow History

Signals and human interactions MUST be represented in durable workflow
history.

Suggested events include:

``` text
SignalReceived
SignalWaitStarted
SignalWaitCompleted
SignalWaitTimedOut

HumanInteractionCreated
HumanInteractionCompleted
HumanInteractionTimedOut
HumanInteractionCancelled
```

Events SHOULD contain enough information to reconstruct workflow
execution deterministically.

Example:

``` json
{
  "type": "SignalReceived",
  "signalId": "signal-abc123",
  "name": "approval",
  "payload": {
    "approved": true
  },
  "timestamp": "..."
}
```

Human interaction completion:

``` json
{
  "type": "HumanInteractionCompleted",
  "interactionId": "publish-report",
  "decision": {
    "outcome": "approved"
  },
  "timestamp": "..."
}
```

------------------------------------------------------------------------

## 7. Replay Requirements

Signal behavior MUST be deterministic during workflow replay.

During replay:

``` ts
const approval =
  await ctx.waitForSignal("approval");
```

MUST return the signal recorded in workflow history rather than waiting
for a new external event.

Similarly:

``` ts
const decision =
  await ctx.approval(...);
```

MUST reconstruct the recorded interaction and return the recorded
decision when the interaction has already completed.

Replay MUST NOT:

-   Recreate completed human interactions.
-   Deliver signals twice.
-   Re-run external side effects.
-   Generate new IDs for existing deterministic interaction points.
-   Require a human to approve something again.

------------------------------------------------------------------------

## 8. Crash Recovery

The following scenario MUST work:

``` text
Workflow starts
      ↓
Agent executes
      ↓
Human interaction created
      ↓
Workflow suspends
      ↓
Drassos process stops
      ↓
Drassos restarts
      ↓
Interaction remains pending
      ↓
Human approves
      ↓
Signal/decision persisted
      ↓
Workflow scheduled
      ↓
Workflow replays
      ↓
Approval result restored
      ↓
Workflow continues
```

No workflow state or human interaction may be lost.

------------------------------------------------------------------------

## 9. Concurrency Requirements

Drassos MUST protect against races involving external events.

Important cases include:

### Signal arrives while workflow is transitioning into wait

The signal MUST either:

-   Be consumed by the wait, or
-   Remain buffered for subsequent consumption.

It MUST NOT be lost.

### Two processes attempt to complete the same interaction

Exactly one logical completion MUST be recorded.

### Duplicate signal delivery

The same signal ID MUST NOT produce multiple logical events.

### Signal and timeout race

If a signal arrives at approximately the same time as a timeout,
workflow history MUST establish one deterministic winner.

Replay MUST reproduce the same outcome.

------------------------------------------------------------------------

## 10. Storage Requirements

The persistence layer MUST support:

-   Durable signal events.
-   Pending signal waits.
-   Pending human interactions.
-   Completed human decisions.
-   Interaction timeout state.
-   Signal idempotency information.

The implementation SHOULD avoid introducing a completely independent
persistence mechanism for human interactions.

Where possible, existing workflow history and durable execution storage
should remain the source of truth.

Derived/query tables or indexes MAY be introduced for efficient
pending-interaction queries.

------------------------------------------------------------------------

## 11. Developer API

The desired v0.4 workflow API should support code similar to:

``` ts
export const reportWorkflow = workflow(
  "report-workflow",
  async (ctx, input: ReportRequest) => {
    const research = await ctx.agent(
      "researcher",
      async () => {
        // agent execution
      }
    );

    const report = await ctx.agent(
      "writer",
      async () => {
        // generate report
      }
    );

    const decision = await ctx.approval({
      id: "publish-report",
      title: "Publish generated report?",
      description: "Review the report before publishing.",
      timeout: "48h",
    });

    switch (decision.outcome) {
      case "approved":
        return await ctx.activity("publish", async () => {
          return publishReport(report);
        });

      case "changes_requested":
        // revision behavior
        break;

      case "rejected":
        return {
          status: "rejected",
          reason: decision.reason,
        };
    }
  }
);
```

Generic signal waits should remain independently available:

``` ts
const payment =
  await ctx.waitForSignal<PaymentEvent>(
    "payment-received"
  );
```

------------------------------------------------------------------------

## 12. Observability

Existing workflow inspection tools SHOULD display waiting state.

Example CLI output:

``` text
Workflow: report-123
Status: WAITING

Waiting for:
  Type: Human Approval
  ID: publish-report
  Title: Publish generated report?
  Created: 2026-09-18T15:00:00Z
```

Workflow history output SHOULD show signal and interaction events.

A graphical debugger/UI is not required until a later milestone.

------------------------------------------------------------------------

## 13. CLI Support

If Drassos currently exposes a CLI, v0.4 SHOULD add basic commands for
development/testing.

Examples:

``` bash
drassos signal workflow-123 approval \
  --data '{"approved":true}'
```

and:

``` bash
drassos interactions workflow-123
```

Completion MAY be supported:

``` bash
drassos approve workflow-123 publish-report
```

or:

``` bash
drassos interaction complete \
  workflow-123 \
  publish-report \
  --outcome approved
```

CLI ergonomics are secondary to the underlying SDK and engine behavior.

------------------------------------------------------------------------

## 14. Testing Requirements

### Unit tests

Cover:

-   Signal serialization.
-   Signal matching.
-   Signal ordering.
-   Signal buffering.
-   Signal idempotency.
-   Human decision serialization.
-   Interaction state transitions.
-   Timeout handling.

### Integration tests

Cover:

#### Basic signal

``` text
start workflow
wait for signal
send signal
verify workflow resumes
```

#### Signal before wait

``` text
start workflow
send signal
workflow reaches wait
verify buffered signal consumed
```

#### Multiple signals

``` text
send A
send B
send C
verify consumption A -> B -> C
```

#### Duplicate signal

``` text
send signal ID X
send signal ID X again
verify one logical delivery
```

#### Human approval

``` text
workflow creates approval
verify pending interaction
approve
verify workflow resumes
```

#### Request changes

``` text
workflow creates approval
request changes with feedback
verify workflow receives feedback
```

#### Rejection

``` text
workflow creates approval
reject
verify workflow follows rejection path
```

#### Timeout

``` text
workflow waits
advance/expire durable timer
verify timeout path
```

#### Signal/timeout race

Verify one deterministic result is recorded and replay produces the same
result.

------------------------------------------------------------------------

## 15. Crash-Recovery Tests

Crash recovery is a release-blocking requirement.

Automated tests SHOULD perform:

``` text
start workflow
reach waitForSignal()
terminate engine
restart engine
send signal
verify workflow completes
```

And:

``` text
start workflow
reach approval()
terminate engine
restart engine
verify approval remains pending
complete approval
verify workflow completes
```

Also test:

``` text
signal accepted
terminate engine immediately
restart engine
verify signal was not lost
```

------------------------------------------------------------------------

## 16. Demo Application

v0.4 SHOULD include an example demonstrating human-in-the-loop agent
execution.

Recommended demo:

### AI Report Approval

``` text
Start
  │
  ▼
Research Agent
  │
  ▼
Writer Agent
  │
  ▼
Human Review
  │
  ├── Approve ───────────► Publish
  │
  ├── Reject ────────────► End
  │
  └── Changes Requested
              │
              ▼
          Writer Agent
              │
              └──────────► Human Review
```

The demo MUST demonstrate durable suspension.

Suggested demonstration:

1.  Start the workflow.
2.  Allow agents to generate the report.
3.  Confirm workflow enters `WAITING`.
4.  Stop Drassos completely.
5.  Restart Drassos.
6.  Query pending interactions.
7.  Submit approval.
8.  Observe workflow resume.
9.  Confirm publication step executes exactly once.

------------------------------------------------------------------------

## 17. Acceptance Criteria

v0.4 is complete when all of the following are true:

-   [ ] Workflows can receive named external signals.
-   [ ] Signal payloads are durably persisted.
-   [ ] Workflows can durably wait for signals.
-   [ ] Waiting workflows consume no worker.
-   [ ] Signals arriving before a wait are not lost.
-   [ ] Multiple signals are consumed deterministically.
-   [ ] Duplicate signal delivery can be made idempotent.
-   [ ] Signal waits support durable timeouts.
-   [ ] Human approval interactions can be created.
-   [ ] Human interactions survive process restarts.
-   [ ] Humans can approve an interaction.
-   [ ] Humans can reject an interaction.
-   [ ] Humans can request changes with feedback.
-   [ ] Human interactions support timeouts.
-   [ ] Pending interactions can be queried.
-   [ ] SDK APIs exist for signaling and completing interactions.
-   [ ] HTTP APIs exist for signaling workflows.
-   [ ] Minimal HTTP APIs exist for human interactions.
-   [ ] Signal events appear in workflow history.
-   [ ] Human interaction events appear in workflow history.
-   [ ] Replay reproduces recorded signal results.
-   [ ] Replay reproduces recorded human decisions.
-   [ ] Signal/timeout races resolve deterministically.
-   [ ] Duplicate completion cannot resume a workflow twice.
-   [ ] Crash/restart tests pass.
-   [ ] AI Report Approval demo passes end-to-end.

------------------------------------------------------------------------

## 18. Suggested Implementation Order

### Phase 1 --- Signal model

Implement:

-   Signal event types.
-   Signal persistence.
-   Signal IDs/idempotency.
-   Client signal API.

### Phase 2 --- Durable signal waiting

Implement:

-   `ctx.waitForSignal()`.
-   Workflow suspension.
-   Signal matching.
-   Buffered signals.
-   Deterministic ordering.
-   Resume scheduling.
-   Replay.

### Phase 3 --- Signal timeouts

Integrate signal waits with durable timers.

Handle deterministic signal-vs-timeout races.

### Phase 4 --- Human interaction model

Implement:

-   Interaction records.
-   `ctx.approval()`.
-   Human decisions.
-   Completion API.
-   Pending interaction queries.

### Phase 5 --- HTTP + CLI

Expose:

-   Signal HTTP API.
-   Human interaction HTTP API.
-   Development CLI commands.

### Phase 6 --- Recovery and concurrency

Add:

-   Crash/restart tests.
-   Duplicate signal tests.
-   Duplicate completion tests.
-   Timeout race tests.
-   Atomic persistence checks.

### Phase 7 --- Demo

Implement the AI Report Approval workflow and document how to run it.

------------------------------------------------------------------------

## 19. Architecture Principle

Signals should become a fundamental Drassos primitive:

``` text
             External World
                   │
                   ▼
                Signal
                   │
          ┌────────┴────────┐
          ▼                 ▼
    Generic Event      Human Interaction
          │                 │
          │           approve/reject/
          │           request changes
          │                 │
          └────────┬────────┘
                   ▼
            Durable History
                   │
                   ▼
             Workflow Resume
```

Human-in-the-loop functionality should therefore be an application of
the durable signal/event system rather than an isolated feature.

This foundation will later support:

-   Webhooks.
-   External service events.
-   Cross-workflow communication.
-   Multi-agent coordination.
-   MCP-driven interactions.
-   A2A communication.
-   User interfaces.
-   Human task inboxes.
-   Escalation policies.

------------------------------------------------------------------------

## 20. Definition of Done

Drassos v0.4 is considered done when a workflow can reach a human
approval step, persist that state, shut down completely, restart later,
receive the human decision through an external API, replay
deterministically, and continue execution exactly once from the recorded
decision.

The canonical v0.4 proof should be:

``` text
Agent executes
      ↓
Human approval requested
      ↓
Workflow durably suspended
      ↓
Drassos stopped
      ↓
Drassos restarted
      ↓
Approval still pending
      ↓
Human approves
      ↓
Workflow resumes
      ↓
Next activity executes exactly once
```

If this scenario works reliably under automated crash/recovery testing,
the central v0.4 requirement has been satisfied.
