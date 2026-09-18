# Drassos v0.8 Requirements

**Version:** 0.8  
**Theme:** Observability, Debugger, and Web UI  
**Status:** Planned

## 1. Overview

Drassos v0.8 adds the operational and debugging experience required to understand running and completed workflows. The release should make workflow execution, agent activity, tool calls, human interactions, child workflows, retries, failures, and durable history visible through a consistent observability model, management API, and React-based web UI.

The primary goal is:

> Give developers a complete visual understanding of what Drassos is doing, what it did, and why.

v0.8 should build on the durable execution history introduced in earlier releases rather than create a competing source of truth.

## 2. Goals

- Provide a normalized observability model for all execution types.
- Expose workflow execution and history through public management APIs.
- Provide a browser-based Drassos UI.
- Visualize workflow execution as an interactive graph.
- Inspect agents, model calls, tools, MCP calls, human tasks, and child workflows.
- Provide a chronological execution timeline.
- Support live updates for running workflows.
- Make failures, retries, waiting states, and performance bottlenecks easy to diagnose.
- Provide historical state inspection and the foundation for replay/fork debugging.
- Track agent-specific metrics such as model latency, token usage, and estimated cost when available.

## 3. Non-Goals

The following are explicitly out of scope for v0.8:

- Drag-and-drop workflow authoring.
- BPMN-style workflow modeling.
- Full APM replacement functionality.
- Log aggregation comparable to Datadog, Splunk, or Elasticsearch.
- Production-grade distributed tracing backend implementation when an external standard/backend can be integrated instead.
- Editing workflow definitions through the UI.
- Arbitrary mutation of historical workflow state.

## 4. Architecture Principles

### 4.1 Durable history remains authoritative

The workflow event/history store remains the authoritative record of execution. Observability data should reference, project, enrich, or index this information rather than independently redefine workflow state.

### 4.2 Public API boundary

The Drassos Web UI MUST consume the same supported management APIs available to other clients.

The UI MUST NOT directly access internal persistence tables or repositories.

### 4.3 Unified execution hierarchy

Observability MUST represent deterministic and agentic operations in one hierarchy.

Example:

```text
WorkflowRun
 ├── WorkflowStep
 │    ├── ActivityRun
 │    ├── AgentRun
 │    │    ├── ModelCall
 │    │    ├── ToolCall
 │    │    └── MCPCall
 │    ├── HumanTask
 │    └── ChildWorkflow
```

### 4.4 Correlation

Every observable operation MUST be traceable back to its workflow run and, where applicable, its parent operation.

## 5. Observability Data Model

### 5.1 Execution identifiers

Observable records MUST support identifiers sufficient to correlate execution across workers and process boundaries.

Recommended fields:

```ts
interface ExecutionIdentity {
  workflowId: string;
  runId: string;
  operationId: string;
  parentOperationId?: string;
  traceId?: string;
  spanId?: string;
}
```

### 5.2 Common operation fields

Observable operations SHOULD expose:

- ID
- type
- parent ID
- workflow ID
- run ID
- status
- start timestamp
- completion timestamp
- duration
- attempt number
- worker identity
- input metadata
- output metadata
- error information
- tags/attributes

### 5.3 Operation types

At minimum, v0.8 MUST recognize:

- workflow
- workflow step
- activity
- agent
- model call
- tool call
- MCP call
- human task
- child workflow
- timer
- signal

### 5.4 Status model

The UI and API MUST consistently represent statuses such as:

- scheduled
- queued
- running
- waiting
- retrying
- completed
- failed
- cancelled
- suspended
- timed out

## 6. Telemetry Instrumentation

Drassos SHOULD automatically instrument engine-controlled operations.

Developers should not have to manually emit telemetry for standard Drassos primitives.

Instrumentation SHOULD capture:

- workflow start/end
- step start/end
- activity execution
- agent execution
- model calls
- tool calls
- MCP calls
- child workflow creation/completion
- signal delivery
- human-task lifecycle
- retries
- timer creation/firing
- errors

Telemetry collection MUST NOT change workflow semantics.

Observability failures MUST NOT normally cause workflow execution failures.

## 7. Agent Observability

Agent execution is a first-class observability concept.

### 7.1 Agent run information

The system SHOULD expose:

- agent name/type
- model/provider
- start/end time
- duration
- status
- attempt
- input
- output
- model calls
- tool calls
- MCP calls
- token usage when available
- estimated model cost when available
- errors

### 7.2 Model calls

Model calls SHOULD expose:

- provider
- model
- request timestamp
- response timestamp
- latency
- input token count
- output token count
- total token count
- estimated cost
- status
- retry information

Sensitive prompt/output content MUST be handled according to configurable observability policies.

### 7.3 Tool calls

Tool-call inspection SHOULD expose:

- tool name
- invocation ID
- arguments
- result
- latency
- status
- attempt
- error

MCP calls SHOULD additionally expose server/tool identity when available.

## 8. Management / Observability API

Implement supported APIs for the UI and external tooling.

Suggested routes:

```http
GET /api/workflows
GET /api/workflows/:workflowId

GET /api/runs
GET /api/runs/:runId
GET /api/runs/:runId/events
GET /api/runs/:runId/trace
GET /api/runs/:runId/graph
GET /api/runs/:runId/logs
```

Exact route naming may follow existing Drassos conventions.

### 8.1 Run filtering

`GET /api/runs` SHOULD support filters for:

- workflow
- status
- agent
- worker
- start/end date
- duration
- tag
- failure state

Pagination MUST be supported.

### 8.2 Run details

A run detail response MUST provide enough information to render:

- summary
- execution graph
- timeline
- current status
- inputs/outputs
- errors
- child executions
- pending work

### 8.3 Graph endpoint

The graph representation SHOULD return nodes and edges independent of the UI implementation.

Example:

```ts
interface ExecutionGraph {
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
}
```

This allows alternate clients to visualize executions without depending on React-specific structures.

## 9. Drassos Web UI

Create a React + TypeScript web application.

Suggested location:

```text
apps/
  drassos-ui/
```

The UI SHOULD remain deployable separately from the engine/server.

## 10. Executions Dashboard

The default dashboard SHOULD show recent workflow runs.

Display useful fields including:

- run ID
- workflow name/type
- status
- start time
- duration
- current step

Example:

```text
RUN            WORKFLOW          STATUS      DURATION
01K4...        research-agent    Running     42s
01K3...        support-ticket    Complete    8.2s
01K2...        travel-planner    Failed      13.7s
01K1...        approval-flow     Waiting     2h
```

The dashboard MUST allow users to open an individual execution.

## 11. Execution Detail View

The execution detail page SHOULD contain multiple coordinated views of the same run:

- summary
- graph
- timeline/history
- selected-node inspector
- errors
- metadata

Selecting an operation in one view SHOULD make it possible to locate the corresponding operation in the others.

## 12. Visual Execution Graph

Provide an interactive execution graph.

Example:

```text
              ┌─────────────┐
              │ Start       │
              └──────┬──────┘
                     ▼
              ┌─────────────┐
              │ Agent       │
              │ Researcher  │
              └──────┬──────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
        ┌──────────┐   ┌──────────┐
        │ MCP Tool │   │ Web Tool │
        └────┬─────┘   └────┬─────┘
             └──────┬───────┘
                    ▼
             ┌────────────┐
             │ Human      │
             │ Approval   │
             └─────┬──────┘
                   ▼
             ┌────────────┐
             │ Complete   │
             └────────────┘
```

### 12.1 Node types

The graph SHOULD visually distinguish:

- workflow
- activity
- agent
- model
- tool
- MCP
- human task
- child workflow
- timer/signal where useful

### 12.2 Node state

Nodes MUST visibly indicate relevant states such as:

- running
- completed
- failed
- waiting
- retrying
- cancelled
- suspended

### 12.3 Interaction

Users SHOULD be able to:

- pan
- zoom
- fit graph to screen
- select a node
- inspect node details
- navigate to child workflows

Large graphs SHOULD support collapsing nested operations.

## 13. Operation Inspector

Selecting a graph node or timeline event SHOULD open an inspector.

The inspector SHOULD display fields appropriate to the selected operation.

For an agent:

```text
Agent: RestaurantResearcher
Duration: 8.42s
Model: <model>
Status: Complete

Input
...

Model Calls
...

Tool Calls
...

Output
...

Tokens
Input:  8,241
Output: 1,842

Estimated Cost
$0.047
```

The UI SHOULD avoid exposing secrets and sensitive values by default.

## 14. Execution Timeline

Provide a chronological event view.

Example:

```text
12:04:01.032 WorkflowStarted
12:04:01.044 AgentScheduled
12:04:01.051 AgentStarted
12:04:02.281 ModelCallStarted
12:04:04.382 ModelCallCompleted
12:04:04.390 ToolCallStarted
12:04:04.812 ToolCallCompleted
12:04:06.124 AgentCompleted
12:04:06.130 HumanTaskCreated
12:06:42.819 SignalReceived
12:06:42.824 HumanTaskCompleted
12:06:42.841 WorkflowCompleted
```

Users SHOULD be able to filter events by type.

Selecting an event SHOULD expose its payload and associated operation.

## 15. Historical State Inspection

The debugger SHOULD allow developers to inspect workflow state at meaningful points in execution history.

Potential state information includes:

- workflow variables/state
- context
- completed steps
- pending activities
- pending timers
- pending signals
- pending human tasks
- child workflows
- agent outputs

Historical inspection MUST NOT mutate the original workflow.

## 16. Replay and Fork Foundation

v0.8 SHOULD establish APIs and abstractions necessary for later replay/fork debugging.

If feasible within v0.8, provide an experimental action to create a new execution based on a historical point.

Conceptually:

```text
Original Run
     │
     ├── events 1-42
     │
     └── Fork
          │
          └── New Run
```

The original execution MUST remain immutable.

A fork MUST receive a new run ID and retain provenance linking it to the original run/event.

Full arbitrary state editing is not required.

## 17. Live Execution Updates

The UI SHOULD receive live execution updates without page refresh.

SSE is preferred for simple server-to-client event streaming unless bidirectional communication is required; WebSocket may be used where justified.

The live stream SHOULD support events such as:

- operation started
- operation completed
- operation failed
- retry scheduled
- signal received
- human task created/completed
- child workflow created/completed
- workflow completed

The UI SHOULD reconnect after transient network failures.

## 18. Search and Diagnostics

Provide execution search/filtering sufficient for developer diagnostics.

Desired query concepts include:

```text
status:failed
workflow:research-agent status:failed
agent:planner duration:>10s
tool:web-search status:failed
waiting:human duration:>1h
```

A structured filtering API may be implemented before a textual query language. The textual syntax is not required if equivalent functionality exists.

## 19. Aggregate Metrics

Provide a small operational overview rather than a full monitoring product.

Useful metrics include:

- active workflow count
- completed workflow count
- failed workflow count
- success/failure rate
- workflow latency
- agent latency
- tool latency
- tool failure rate
- retry rate
- workflows waiting on humans
- token usage
- estimated model cost

Where practical, expose percentile latency such as p50/p95/p99.

## 20. Logs

Execution-related logs SHOULD be correlatable using run/operation identifiers.

The UI MAY provide a lightweight log view for logs associated with a run.

Drassos SHOULD NOT attempt to become a general-purpose centralized logging platform in v0.8.

## 21. OpenTelemetry Compatibility

The observability architecture SHOULD be compatible with OpenTelemetry concepts where practical.

Drassos SHOULD be capable of associating workflow and agent operations with trace/span identifiers.

A future exporter should be possible without redesigning the core execution model.

Native OpenTelemetry export is desirable for v0.8 but MAY be deferred if necessary to keep scope manageable.

## 22. Data Retention and Payload Controls

Observability can contain sensitive information, especially agent prompts, model outputs, and tool arguments.

Provide configuration for controlling capture of:

- workflow inputs
- workflow outputs
- agent inputs
- agent outputs
- model prompts
- model responses
- tool arguments
- tool results

Support at least:

```text
full
metadata-only
disabled
```

Secrets known to Drassos MUST be redacted.

## 23. Authorization

Observability APIs MUST use the project's existing authentication/authorization model where applicable.

Users MUST NOT gain access to workflow data merely because the UI exists.

Authorization SHOULD be enforced by the server/API rather than solely by the frontend.

## 24. Performance

Observability MUST introduce minimal overhead to normal workflow execution.

Requirements:

- telemetry writes SHOULD NOT unnecessarily block workflow execution
- large histories MUST be paginated or streamed
- large graphs MUST be incrementally retrievable/renderable where practical
- the UI MUST remain usable for long-running workflows with large histories

Performance benchmarks SHOULD be added for telemetry-heavy workflows.

## 25. Failure Handling

The observability subsystem MUST handle:

- incomplete traces
- worker crashes
- duplicate events
- retries
- reconnects
- partially written telemetry
- unknown/custom operation types

The UI MUST degrade gracefully when optional telemetry is unavailable.

## 26. Testing Requirements

### 26.1 Unit tests

Add tests for:

- telemetry/event mapping
- trace hierarchy construction
- graph generation
- duration calculations
- status mapping
- cost/token aggregation
- redaction
- filtering

### 26.2 Integration tests

Test complete traces containing combinations of:

- activities
- agents
- model calls
- tools
- MCP calls
- child workflows
- human tasks
- signals
- retries
- failures

### 26.3 UI tests

Test:

- execution list rendering
- filtering
- graph rendering
- node selection
- inspector rendering
- timeline interaction
- live updates
- failure states
- reconnect behavior

### 26.4 End-to-end test

Create at least one demonstration workflow containing:

```text
Workflow
  -> Agent
      -> Model
      -> Tool
  -> Child Workflow
  -> Human Approval
  -> Agent
  -> Complete
```

The E2E test MUST verify that the entire execution can be reconstructed and inspected through the Drassos UI.

## 27. Documentation

Add documentation covering:

- starting the Drassos UI
- configuring the observability subsystem
- accessing the management API
- telemetry retention
- sensitive payload configuration
- reading the execution graph
- debugging failed workflows
- debugging agents/tool calls
- OpenTelemetry integration if implemented

## 28. Suggested Implementation Phases

### Phase 1 — Observability Core

- Define normalized telemetry model.
- Instrument core execution primitives.
- Implement trace hierarchy.
- Add persistence/query layer.

### Phase 2 — Management API

- Run listing.
- Run details.
- Event history.
- Trace endpoint.
- Graph endpoint.
- Filtering/pagination.

### Phase 3 — UI Foundation

- React/TypeScript application.
- API client.
- routing/navigation.
- executions dashboard.
- execution detail shell.

### Phase 4 — Visual Debugger

- execution graph.
- operation inspector.
- timeline.
- agent/model/tool inspectors.
- child workflow navigation.

### Phase 5 — Live Observability

- SSE/WebSocket event stream.
- live graph/status updates.
- reconnect handling.

### Phase 6 — Advanced Diagnostics

- historical state inspection.
- aggregate metrics.
- search/filter improvements.
- experimental replay/fork support if scope permits.

## 29. Acceptance Criteria

v0.8 is complete when:

1. A developer can launch a local Drassos web UI.
2. The UI can list recent workflow executions.
3. Runs can be filtered by at least workflow and status.
4. A developer can open an individual workflow run.
5. The complete execution hierarchy can be displayed as a graph.
6. Agents, activities, tools, MCP calls, human tasks, and child workflows are distinguishable.
7. Selecting an operation displays its execution details.
8. Agent runs expose associated model and tool calls.
9. Token usage and estimated cost are shown when provider data is available.
10. A chronological workflow event timeline is available.
11. Failed operations expose useful error and retry information.
12. Running workflows update in the UI without requiring a manual refresh.
13. Historical workflow state can be inspected at supported execution points.
14. Sensitive payload capture can be restricted or disabled.
15. All UI data is retrieved through supported Drassos APIs rather than direct database access.
16. Observability does not alter workflow semantics or durability guarantees.
17. Automated tests cover representative deterministic, agentic, human, and child-workflow executions.

## 30. Definition of Done

Drassos v0.8 should allow a developer encountering a failed or unexpected workflow to answer, from the Drassos UI:

- What ran?
- In what order?
- What is running now?
- What is waiting?
- Which agent made the call?
- Which model was used?
- Which tools were invoked?
- What child workflows were created?
- Which human interactions occurred?
- Where did the workflow fail?
- Was it retried?
- How long did each operation take?
- What did the workflow state look like at key points?

At the end of v0.8, Drassos should be not only a durable distributed agentic workflow engine, but an engine whose behavior developers can inspect and debug visually.

## 31. Follow-On Work

Potential v0.9 work intentionally deferred from this release:

- improved CLI and local developer experience
- workflow simulation
- workflow testing utilities
- hot reload
- visualization generated directly from workflow definitions
- workflow authoring assistance
- visual workflow designer
- deeper replay/fork tooling
- production dashboards and alerting
