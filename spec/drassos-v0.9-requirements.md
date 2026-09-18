# Drassos v0.9 Requirements

**Version:** 0.9\
**Theme:** Workflow Evolution & Production Safety\
**Status:** Proposed

## 1. Overview

Drassos v0.9 introduces the production-safety capabilities required to
evolve durable workflows without breaking executions that are already in
progress.

Earlier versions establish workflow execution, durability, agents and
tools, human interaction, child workflows, interoperability, distributed
execution, and observability. v0.9 builds on those capabilities by
making workflow changes explicit, testable, replayable, and safely
deployable.

The primary goals are:

-   Version workflow definitions.
-   Associate every execution with the workflow version that created it.
-   Replay execution history deterministically without repeating
    external side effects.
-   Detect behavioral divergence between recorded history and new
    workflow code.
-   Route executions only to workers compatible with their workflow
    version.
-   Support rolling deployments containing multiple workflow versions.
-   Export and import execution histories for debugging and testing.
-   Use real execution histories as regression tests for new workflow
    implementations.

------------------------------------------------------------------------

## 2. Goals

Drassos v0.9 MUST enable developers to:

1.  Deploy a new workflow implementation without silently changing
    existing executions.
2.  Keep old and new workflow versions running simultaneously.
3.  Reconstruct workflow execution from persisted history.
4.  Replay workflow logic without re-executing activities, tools,
    agents, or other external side effects.
5.  Detect when new workflow code produces decisions inconsistent with
    recorded history.
6.  Validate a new workflow implementation against one or many
    historical executions before deployment.
7.  Export a production execution and reproduce its orchestration
    behavior locally.
8.  Determine whether a worker can safely execute a particular workflow
    execution.
9.  Perform rolling deployments without requiring all long-running
    workflows to complete first.

------------------------------------------------------------------------

## 3. Non-Goals

v0.9 does NOT need to provide:

-   Automatic migration of arbitrary workflow state between incompatible
    versions.
-   Automatic rewriting of workflow source code to make it
    replay-compatible.
-   Full semantic equivalence analysis of arbitrary application code.
-   Exactly-once execution of arbitrary external systems.
-   Cross-version migration of arbitrary agent memory.
-   Automatic rollback of application infrastructure.
-   A complete CI/CD platform.
-   Production multi-tenancy or billing.
-   General-purpose event sourcing outside Drassos workflows.

These may be addressed in later releases.

------------------------------------------------------------------------

## 4. Terminology

### Workflow Definition

A named workflow implementation registered with Drassos.

Example:

``` ts
workflow("order-processing", {
  version: "2.0.0",
  run: async (ctx) => {
    // ...
  }
});
```

### Workflow Version

An immutable identifier representing the workflow implementation
expected by an execution.

### Execution History

The ordered durable event stream representing the externally observable
orchestration decisions and results of a workflow execution.

### Replay

Re-execution of workflow orchestration logic using recorded history
instead of repeating previously completed external operations.

### Divergence

A condition where replayed workflow code requests or produces an
orchestration event inconsistent with the recorded history.

### Compatible Worker

A worker that has registered an implementation capable of processing the
workflow name and version required by an execution.

------------------------------------------------------------------------

# 5. Workflow Versioning

## 5.1 Versioned Workflow Registration

Workflow definitions MUST support an explicit version.

``` ts
workflow("order-processing", {
  version: "2.0.0",

  run: async (ctx) => {
    // workflow
  }
});
```

Drassos MUST uniquely identify a workflow implementation by:

``` text
workflow name + workflow version
```

Example:

``` text
order-processing@1.0.0
order-processing@1.1.0
order-processing@2.0.0
```

Multiple versions of the same workflow MAY be registered simultaneously.

------------------------------------------------------------------------

## 5.2 Version Validation

Versions SHOULD use semantic versioning.

The engine MUST reject:

-   Missing versions when version enforcement is enabled.
-   Invalid version syntax.
-   Duplicate registrations of the same workflow/version within a worker
    unless explicitly allowed by configuration.

Example error:

``` text
WorkflowRegistrationError

Workflow "order-processing@2.0.0" is already registered.
```

------------------------------------------------------------------------

## 5.3 Execution Version Binding

When an execution starts, Drassos MUST persist:

``` ts
{
  workflowName: "order-processing",
  workflowVersion: "2.0.0"
}
```

The version MUST NOT silently change during the execution.

Restarting or resuming the execution MUST use a compatible workflow
implementation.

------------------------------------------------------------------------

## 5.4 Default Version Selection

Starting a workflow by name MAY resolve to a configured default version.

Example:

``` ts
await client.start("order-processing", input);
```

Explicit version selection MUST also be supported.

``` ts
await client.start("order-processing", input, {
  version: "2.0.0"
});
```

The version actually selected MUST be persisted before workflow
execution begins.

------------------------------------------------------------------------

# 6. Execution History

## 6.1 Durable Event Stream

Drassos MUST persist sufficient history to reconstruct orchestration
behavior.

Events SHOULD include, where applicable:

``` text
ExecutionStarted
WorkflowTaskStarted
WorkflowTaskCompleted
ActivityScheduled
ActivityStarted
ActivityCompleted
ActivityFailed
ToolCallScheduled
ToolCallCompleted
ToolCallFailed
AgentStarted
AgentCompleted
AgentFailed
SignalReceived
HumanTaskCreated
HumanTaskCompleted
TimerScheduled
TimerFired
ChildWorkflowStarted
ChildWorkflowCompleted
ChildWorkflowFailed
ExecutionCompleted
ExecutionFailed
ExecutionCancelled
```

The exact internal event model MAY differ, but replay MUST have enough
information to reproduce deterministic workflow decisions.

------------------------------------------------------------------------

## 6.2 Event Ordering

Every history event MUST have a stable sequence position.

Example:

``` ts
{
  sequence: 42,
  type: "ToolCallCompleted",
  timestamp: "...",
  data: { ... }
}
```

Sequence ordering MUST be authoritative during replay.

------------------------------------------------------------------------

## 6.3 Event Identity

Events MUST contain stable identifiers where needed to correlate
operations.

Examples include:

-   execution ID
-   activity ID
-   tool-call ID
-   agent invocation ID
-   timer ID
-   child workflow ID
-   human task ID

------------------------------------------------------------------------

# 7. Deterministic Replay

## 7.1 Replay Engine

Drassos MUST provide a replay mode capable of executing workflow
orchestration code against an existing execution history.

During replay:

-   Workflow code executes.
-   Previously recorded external operations MUST NOT execute again.
-   Recorded results MUST be supplied to workflow code.
-   New orchestration decisions MUST be compared against recorded
    history.

------------------------------------------------------------------------

## 7.2 Side-Effect Suppression

Replay MUST NOT repeat previously completed:

-   HTTP requests
-   tool calls
-   MCP calls
-   agent invocations
-   activities
-   child workflow starts
-   human requests
-   signals
-   timers
-   arbitrary registered side effects

For example:

``` ts
const result = await ctx.tool("searchRestaurants", input);
```

During normal execution:

``` text
execute tool -> persist result -> return result
```

During replay:

``` text
read persisted result -> return result
```

------------------------------------------------------------------------

## 7.3 Deterministic APIs

Drassos SHOULD provide workflow-safe APIs for nondeterministic
operations.

Examples:

``` ts
ctx.now()
ctx.random()
ctx.uuid()
```

Their values MUST be recorded or deterministically reproduced during
replay.

Workflow documentation MUST discourage direct use of nondeterministic
APIs such as:

``` ts
Date.now()
Math.random()
crypto.randomUUID()
```

inside deterministic orchestration logic unless wrapped by Drassos.

------------------------------------------------------------------------

# 8. Divergence Detection

## 8.1 Replay Comparison

During replay, Drassos MUST compare expected orchestration operations
against recorded history.

Example divergence:

``` text
Recorded:
ToolCall(searchRestaurants)

Replayed:
ToolCall(searchRestaurantsV2)
```

This MUST produce a replay failure.

------------------------------------------------------------------------

## 8.2 Divergence Report

A divergence report MUST include, where available:

``` text
execution ID
workflow name
execution workflow version
tested workflow version
history sequence
expected event
actual event
source location
reason
```

Example:

``` text
ReplayDivergenceError

Execution: 01K8...
Workflow: restaurant-council
Recorded version: 1.3.0
Tested version: 1.4.0
History sequence: 27

Expected:
  ToolCall(searchRestaurants)

Actual:
  ToolCall(searchRestaurantsV2)

Source:
  workflows/restaurantCouncil.ts:84
```

------------------------------------------------------------------------

## 8.3 Divergence Categories

Drassos SHOULD classify divergences.

Initial categories:

``` text
OPERATION_CHANGED
OPERATION_ADDED
OPERATION_REMOVED
ORDER_CHANGED
INPUT_CHANGED
BRANCH_CHANGED
MISSING_HANDLER
INCOMPATIBLE_STATE
UNKNOWN
```

------------------------------------------------------------------------

# 9. Replay CLI

The CLI MUST support replaying an execution.

``` bash
drassos replay <execution-id>
```

It SHOULD support testing an execution against locally supplied workflow
code.

``` bash
drassos replay <execution-id> \
  --against ./dist/workflows.js
```

Successful output SHOULD resemble:

``` text
Replay successful

Execution: 01K8...
Workflow: order-processing
Recorded version: 1.2.0
Tested version: 1.3.0
Events replayed: 84
Divergences: 0
```

------------------------------------------------------------------------

# 10. Batch Replay / Regression Testing

## 10.1 Historical Regression Tests

Drassos MUST support replaying multiple histories against a candidate
workflow implementation.

Example:

``` bash
drassos replay \
  --workflow restaurant-council \
  --against ./dist/new-version.js
```

Optional filters SHOULD include:

``` text
--limit
--since
--until
--status
--version
--execution
```

------------------------------------------------------------------------

## 10.2 Batch Report

Results SHOULD summarize compatibility.

Example:

``` text
Replay Regression Report

Workflow: restaurant-council
Candidate: 1.4.0

Histories tested: 1,247

Compatible: 1,231
Divergent: 16

Divergences:

OPERATION_CHANGED       9
BRANCH_CHANGED          4
MISSING_HANDLER         2
INCOMPATIBLE_STATE      1
```

------------------------------------------------------------------------

## 10.3 Machine-Readable Results

Replay commands MUST optionally produce machine-readable output.

At minimum:

``` bash
--json
```

This allows replay validation to run in CI.

The process MUST return a non-zero exit code when unexpected divergence
occurs.

------------------------------------------------------------------------

# 11. Worker Version Compatibility

## 11.1 Worker Registration

Workers MUST advertise supported workflow versions.

Example:

``` ts
createWorker({
  workflows: [
    orderProcessingV1,
    orderProcessingV2,
    restaurantCouncilV3
  ]
});
```

The engine SHOULD derive compatibility from registered definitions where
possible.

Equivalent conceptual registration:

``` ts
{
  "order-processing": ["1.4.0", "2.0.0"],
  "restaurant-council": ["3.1.0"]
}
```

------------------------------------------------------------------------

## 11.2 Routing

The scheduler MUST NOT assign an execution to a worker that cannot
execute the required workflow version.

Given:

``` text
Execution:
order-processing@1.4.0
```

and:

``` text
Worker A:
order-processing@1.4.0

Worker B:
order-processing@2.0.0
```

the execution MUST route to Worker A.

------------------------------------------------------------------------

## 11.3 No Compatible Worker

If no compatible worker exists, the execution MUST remain recoverable
and MUST NOT fail merely because the appropriate worker is temporarily
unavailable.

The execution SHOULD enter a state such as:

``` text
WAITING_FOR_COMPATIBLE_WORKER
```

Observability APIs MUST expose this condition.

------------------------------------------------------------------------

# 12. Safe Rolling Deployments

Drassos MUST support workers running different workflow versions
concurrently.

Example deployment:

``` text
Worker Group A
  order-processing@1.4.0

Worker Group B
  order-processing@1.4.0
  order-processing@2.0.0

Worker Group C
  order-processing@2.0.0
```

Existing `1.4.0` executions continue on compatible workers.

New executions MAY use `2.0.0`.

Once no `1.4.0` executions remain, old workers MAY be removed.

------------------------------------------------------------------------

# 13. Deployment Safety Checks

Drassos SHOULD provide a command that identifies workflow versions still
required by active executions.

Example:

``` bash
drassos workflows required
```

Output:

``` text
Workflow                 Version    Active Executions
order-processing         1.4.0      37
order-processing         2.0.0      214
restaurant-council       3.1.0      8
```

This allows operators to determine whether an old workflow
implementation can safely be removed.

------------------------------------------------------------------------

# 14. Execution Export

The CLI MUST support exporting an execution history.

``` bash
drassos execution export <execution-id>
```

Output MUST contain sufficient information for offline replay.

Example structure:

``` json
{
  "formatVersion": 1,
  "execution": {
    "id": "01K8...",
    "workflow": "restaurant-council",
    "workflowVersion": "1.3.0"
  },
  "history": []
}
```

Sensitive data handling MUST respect existing Drassos redaction and
secret-handling rules.

------------------------------------------------------------------------

# 15. Execution Import / Offline Replay

Drassos MUST support replaying an exported execution.

Example:

``` bash
drassos replay execution.json
```

Developers SHOULD be able to test exported production history against
local workflow code.

``` bash
drassos replay execution.json \
  --against ./dist/workflows.js
```

A database connection SHOULD NOT be required for offline replay when the
export contains all necessary history.

------------------------------------------------------------------------

# 16. Debugger Integration

The v0.8 debugger SHOULD integrate replay functionality.

The UI SHOULD allow developers to:

-   Select an execution.
-   View its workflow/version.
-   Start a replay.
-   Select a candidate workflow version where supported.
-   Inspect replay progress.
-   Jump directly to a divergence.
-   Compare expected and actual operations.
-   Inspect the workflow state immediately before divergence.

------------------------------------------------------------------------

# 17. Observability

v0.9 MUST expose metrics for:

``` text
replay attempts
replay successes
replay divergences
replay duration
executions waiting for compatible workers
executions by workflow version
workers by supported workflow version
```

Structured logs SHOULD include:

``` text
executionId
workflowName
workflowVersion
workerId
replay
historySequence
```

where applicable.

------------------------------------------------------------------------

# 18. Public API Considerations

The SDK SHOULD expose version information.

Example:

``` ts
const execution = await client.execution(id);

execution.workflow.name;
execution.workflow.version;
```

Workflow listing APIs SHOULD expose registered versions.

Example:

``` ts
await client.workflows.list();
```

Potential result:

``` ts
[
  {
    name: "order-processing",
    versions: ["1.4.0", "2.0.0"]
  }
]
```

------------------------------------------------------------------------

# 19. Storage Requirements

The persistence layer MUST store:

``` text
workflow name
workflow version
history format version
ordered history events
event identifiers
recorded deterministic values
operation results required for replay
```

History schema changes MUST themselves be versioned.

Exported histories MUST contain a `formatVersion`.

Future Drassos versions MUST be able to detect unsupported history
formats and return a clear error.

------------------------------------------------------------------------

# 20. Compatibility Policy

For v0.9:

-   Workflow versions are immutable identifiers.
-   Drassos MUST NOT assume two workflow versions are replay-compatible.
-   Compatibility is established by successful replay or explicit
    developer configuration.
-   Removing a workflow implementation MUST NOT modify historical
    executions.
-   Historical execution records MUST retain their original workflow
    version.

------------------------------------------------------------------------

# 21. Failure Handling

Replay failures MUST NOT mutate the original execution.

Replay MUST be read-only by default.

A failed replay MUST NOT:

-   execute tools
-   invoke agents
-   execute activities
-   emit signals
-   complete human tasks
-   start children
-   modify execution state
-   append normal execution events

Replay diagnostic records MAY be stored separately.

------------------------------------------------------------------------

# 22. Security

Execution histories may contain sensitive application data.

Export and replay functionality MUST integrate with Drassos
authorization.

The system MUST support:

-   authorization checks for history access
-   authorization checks for export
-   secret redaction
-   configurable payload redaction
-   audit logging for production history exports

Secrets MUST NOT be embedded into exported history merely to make replay
work.

------------------------------------------------------------------------

# 23. Testing Requirements

## Unit Tests

Cover:

-   version parsing
-   workflow registration
-   execution/version binding
-   history sequencing
-   replay event matching
-   deterministic values
-   divergence classification
-   worker compatibility matching
-   export serialization
-   import validation

## Integration Tests

Verify:

1.  Start a v1 workflow.
2.  Suspend it.
3.  Deploy v2.
4.  Resume v1 on a compatible worker.
5.  Start a new v2 execution.
6.  Replay the v1 execution with v1 code successfully.
7.  Replay the v1 execution against intentionally incompatible v2 code.
8.  Confirm divergence is reported.
9.  Confirm no external side effects occur during either replay.

## Distributed Tests

Verify:

``` text
Worker A -> workflow@1
Worker B -> workflow@2
```

Executions MUST only route to compatible workers.

Terminate Worker A and confirm v1 executions wait rather than being
incorrectly processed by Worker B.

Restart Worker A and confirm those executions resume.

------------------------------------------------------------------------

# 24. Example End-to-End Scenario

Production currently runs:

``` text
restaurant-council@1.3.0
```

There are 5,000 historical executions and 100 currently active
executions.

A developer creates:

``` text
restaurant-council@1.4.0
```

Before deployment:

``` bash
drassos replay \
  --workflow restaurant-council \
  --version 1.3.0 \
  --against ./dist/restaurant-council-1.4.js
```

Drassos reports:

``` text
5,000 histories tested
4,992 compatible
8 divergent
```

The developer investigates the eight cases.

After correcting the workflow:

``` text
5,000 histories tested
5,000 compatible
```

The developer deploys workers supporting both versions:

``` text
restaurant-council@1.3.0
restaurant-council@1.4.0
```

New executions use `1.4.0`.

Existing `1.3.0` executions continue using `1.3.0`.

Eventually:

``` bash
drassos workflows required
```

reports:

``` text
restaurant-council@1.3.0    0
restaurant-council@1.4.0    412
```

The old implementation can then be removed from the deployment.

------------------------------------------------------------------------

# 25. Acceptance Criteria

Drassos v0.9 is complete when:

-   [ ] Workflows can declare explicit versions.
-   [ ] Every execution persists its workflow version.
-   [ ] Multiple workflow versions can coexist.
-   [ ] Workers advertise supported workflow versions.
-   [ ] Executions only route to compatible workers.
-   [ ] Executions wait safely when no compatible worker exists.
-   [ ] Execution history contains enough information for deterministic
    replay.
-   [ ] Replay never repeats recorded external side effects.
-   [ ] Deterministic workflow APIs are available for time/random/ID
    generation.
-   [ ] Replay detects orchestration divergence.
-   [ ] Divergence reports identify expected and actual behavior.
-   [ ] A single execution can be replayed from the CLI.
-   [ ] Multiple historical executions can be replayed as regression
    tests.
-   [ ] Replay supports machine-readable CI output.
-   [ ] Execution histories can be exported.
-   [ ] Exported histories can be replayed offline.
-   [ ] Replay operations do not mutate the original execution.
-   [ ] v0.8 observability/debugger surfaces version and replay
    information.
-   [ ] Rolling deployment of two workflow versions is demonstrated.
-   [ ] Integration tests prove old executions survive deployment of new
    workflow code.
-   [ ] Documentation explains workflow evolution and replay
    constraints.

------------------------------------------------------------------------

# 26. Suggested Implementation Order

### Phase 1 --- Version Identity

Implement:

-   workflow version registration
-   execution/version binding
-   persistence schema changes
-   worker version advertisement
-   compatible-worker routing

### Phase 2 --- Replay Foundation

Implement:

-   history reader
-   replay execution context
-   side-effect substitution
-   deterministic time/random/UUID APIs
-   event comparison

### Phase 3 --- Divergence Detection

Implement:

-   divergence errors
-   classification
-   source/context reporting
-   CLI replay command

### Phase 4 --- Regression Testing

Implement:

-   batch history selection
-   candidate workflow loading
-   summary reports
-   JSON output
-   CI exit codes

### Phase 5 --- Portability

Implement:

-   history export
-   history format versioning
-   offline import/replay
-   redaction/security

### Phase 6 --- Production Integration

Implement:

-   rolling deployment tests
-   required-version reporting
-   v0.8 debugger integration
-   metrics and dashboards
-   documentation

------------------------------------------------------------------------

# 27. Definition of Done

v0.9 is considered production-ready when a developer can:

``` text
change workflow code
        ↓
build candidate version
        ↓
replay historical executions
        ↓
identify incompatible changes
        ↓
deploy old + new versions concurrently
        ↓
route executions to compatible workers
        ↓
allow old executions to finish safely
        ↓
retire the old workflow version
```

without replaying external side effects or corrupting existing execution
state.

------------------------------------------------------------------------

# 28. Roadmap Position

``` text
v0.1  Workflow execution
v0.2  Durable execution
v0.3  Agents + tools
v0.4  Human-in-the-loop + signals
v0.5  Multi-agent orchestration / child workflows
v0.6  MCP + external agent/tool interoperability
v0.7  Distributed workers + production scaling
v0.8  Observability / debugger / UI
v0.9  Workflow evolution & production safety
```

The expected next milestone after v0.9 is **v0.10 / 1.0 hardening**,
focused on API stability, compatibility guarantees, security, deployment
packaging, documentation, benchmarks, operational hardening, and a
production-ready reference deployment.
