# Drassos v0.5 Requirements
## Multi-Agent Orchestration and Child Workflows

**Version:** v0.5  
**Project:** Drassos  
**Status:** Planned  
**Depends on:** v0.1 Workflow Execution, v0.2 Durable Execution, v0.3 Agents + Tools, v0.4 Human-in-the-Loop + Signals

---

## 1. Overview

Drassos v0.5 introduces hierarchical workflow composition and multi-agent orchestration.

The goal is to allow workflows and agents to delegate work to independently durable child executions while keeping Drassos responsible for orchestration, persistence, retries, cancellation, and lifecycle management.

After v0.5, Drassos should support systems such as:

```text
Parent Workflow
    |
    +-- Research Agent
    |
    +-- Child Workflow
    |      |
    |      +-- Analysis Agent
    |      +-- Validation Agent
    |
    +-- Human Approval
    |
    +-- Synthesis Agent
```

Each child workflow or agent execution must remain durable and independently observable while retaining its relationship to the parent execution.

---

## 2. Goals

v0.5 MUST provide:

1. Durable child workflows.
2. Parent/child execution relationships.
3. Workflow-to-agent delegation.
4. Agent-to-agent delegation through Drassos.
5. Parallel agent/workflow execution.
6. Fan-out/fan-in orchestration.
7. Dynamic orchestration based on runtime decisions.
8. Explicit child failure semantics.
9. Explicit cancellation propagation semantics.
10. Nested orchestration.
11. Durable recovery of an entire execution tree.
12. APIs for inspecting execution relationships.

The central architectural rule is:

> Drassos owns orchestration. Agents may request delegation, but child work must be scheduled and tracked by the Drassos runtime.

---

## 3. Non-Goals

The following are explicitly outside v0.5.

### v0.6

- MCP integration
- A2A or other external agent protocols
- External agent discovery
- Remote tool discovery
- Interoperability with third-party agent runtimes

### v0.7

- Distributed worker pools
- Horizontal worker scaling
- Cross-node scheduling
- Production queue infrastructure
- Worker affinity/routing

### v0.8

- Full visual workflow debugger
- Execution graph UI
- Timeline UI
- Advanced tracing UI
- Production observability dashboard

v0.5 SHOULD expose enough runtime metadata for later versions to build these features.

---

# 4. Core Concepts

## 4.1 Execution

Every independently durable unit of work is represented by an execution.

Examples:

- workflow execution
- child workflow execution
- agent execution

An execution MUST have a unique execution ID.

```ts
interface Execution {
  id: string;
  type: "workflow" | "agent";
  status: ExecutionStatus;

  parentExecutionId?: string;
  rootExecutionId: string;

  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}
```

---

## 4.2 Root Execution

Every execution tree MUST have a root execution.

For example:

```text
workflow-A                    root=A
   |
   +-- agent-B                root=A
   |
   +-- workflow-C             root=A
          |
          +-- agent-D         root=A
```

All executions in the tree MUST expose the same `rootExecutionId`.

---

## 4.3 Parent Execution

A child execution MUST record the execution that created it.

```text
Parent Workflow
      |
      +-- Child Workflow
              |
              +-- Agent
```

The relationship MUST survive runtime restarts.

---

# 5. Child Workflows

## 5.1 Awaited Child Workflow

A workflow MUST be able to execute another workflow and wait for its result.

Example API:

```ts
const result = await ctx.workflow("research-topic", {
  topic: "durable agent orchestration"
});
```

The runtime MUST:

1. Resolve the workflow definition.
2. Create a child execution.
3. Persist the parent/child relationship.
4. Start or schedule the child.
5. Suspend the parent while waiting.
6. Resume the parent when the child completes.
7. Return the child's result.

The parent MUST NOT busy-wait.

---

## 5.2 Detached Child Workflow

A workflow SHOULD be able to start a child without immediately waiting for completion.

Example:

```ts
const handle = await ctx.startWorkflow("generate-report", input);
```

The returned handle SHOULD contain:

```ts
interface ExecutionHandle<T = unknown> {
  executionId: string;

  result(): Promise<T>;
  status(): Promise<ExecutionStatus>;
  cancel(): Promise<void>;
}
```

Example:

```ts
const report = await handle.result();
```

Detached children MUST still retain their parent/root execution metadata.

---

## 5.3 Child Workflow Input and Output

Inputs and outputs MUST use the same serialization guarantees as normal durable workflow state.

The engine MUST reject unsupported values before scheduling the child.

---

# 6. Agent Delegation

## 6.1 Workflow-to-Agent Delegation

A workflow MUST be able to invoke an agent.

```ts
const result = await ctx.agent("researcher", {
  task: "Research workflow engines"
});
```

This functionality may build upon the agent primitive introduced in v0.3, but v0.5 MUST ensure the resulting execution participates in the parent/child hierarchy.

---

## 6.2 Agent-to-Agent Delegation

Agents MUST be capable of requesting another agent.

Example conceptual API:

```ts
const result = await ctx.agent("security-reviewer", {
  code
});
```

The calling agent MUST NOT directly execute another agent implementation.

Instead:

```text
Agent
  |
  | delegation request
  v
Drassos Runtime
  |
  | create child execution
  v
Child Agent
```

Drassos MUST persist the delegation before executing the child.

---

## 6.3 Delegation Depth

The engine MUST support nested delegation.

Example:

```text
Workflow
   |
   +-- Planner Agent
          |
          +-- Research Agent
                 |
                 +-- Verification Agent
```

A configurable maximum nesting depth SHOULD be supported to protect against accidental recursive delegation.

Example:

```ts
{
  maxExecutionDepth: 32
}
```

Exceeding the limit MUST fail deterministically with a specific runtime error.

---

# 7. Parallel Execution

## 7.1 Parallel Children

A workflow MUST support multiple child executions concurrently.

Example:

```ts
const [security, architecture, cost] = await Promise.all([
  ctx.agent("security-reviewer", { code }),
  ctx.agent("architect", { code }),
  ctx.agent("cost-reviewer", { code })
]);
```

Each invocation MUST create an independent execution.

Failure or retry of one child MUST NOT cause successful siblings to execute again unnecessarily.

---

## 7.2 Fan-Out

Drassos MUST support dynamically creating multiple children from runtime data.

Example:

```ts
const results = await ctx.map(
  tasks,
  task => ctx.agent(task.agent, task.input)
);
```

`ctx.map()` SHOULD be a durable orchestration primitive rather than simply an alias for JavaScript `Array.map()`.

---

## 7.3 Fan-In

The parent MUST be able to wait until a set of child executions reaches the required terminal state.

Example:

```text
              Parent
                 |
       +---------+---------+
       |         |         |
       v         v         v
     Agent A   Agent B   Agent C
       |         |         |
       +---------+---------+
                 |
                 v
             Aggregator
```

Completed child results MUST be durable so they are not recomputed after a parent restart.

---

## 7.4 Concurrency Limits

Fan-out SHOULD support concurrency limits.

Example:

```ts
const results = await ctx.map(items, processItem, {
  concurrency: 5
});
```

This prevents an agent-generated plan from accidentally spawning unbounded work.

---

# 8. Dynamic Orchestration

## 8.1 Runtime Plans

A workflow MAY use an agent to generate a plan at runtime.

Example:

```ts
const plan = await ctx.agent("planner", {
  task: request
});
```

The resulting plan MAY determine which child agents/workflows are required.

---

## 8.2 Typed Delegation Plan

Drassos SHOULD provide a typed representation for dynamic orchestration.

Example:

```ts
interface DelegationTask {
  id: string;

  type: "agent" | "workflow";
  target: string;

  input: unknown;

  dependsOn?: string[];
}

interface DelegationPlan {
  tasks: DelegationTask[];
}
```

Example:

```json
{
  "tasks": [
    {
      "id": "research",
      "type": "agent",
      "target": "researcher",
      "input": {}
    },
    {
      "id": "security",
      "type": "agent",
      "target": "security-reviewer",
      "input": {}
    },
    {
      "id": "synthesize",
      "type": "agent",
      "target": "writer",
      "dependsOn": ["research", "security"],
      "input": {}
    }
  ]
}
```

---

## 8.3 Plan Validation

Agent-generated orchestration plans MUST NOT execute blindly.

Drassos MUST validate at least:

- target exists
- task type is valid
- dependency references exist
- dependency graph is acyclic
- input can be serialized
- task count is within configured limits
- execution depth is within configured limits
- caller is permitted to invoke the target, if authorization exists

Invalid plans MUST fail before child work is scheduled whenever possible.

---

# 9. Parent/Child Lifecycle

## 9.1 Child Completion

When an awaited child completes successfully:

1. Persist the result.
2. mark the child completed.
3. emit completion metadata/event.
4. make the parent runnable.
5. return the persisted result to the parent.

---

## 9.2 Child Failure

Child invocation MUST support configurable failure behavior.

Proposed API:

```ts
await ctx.workflow("research", input, {
  onFailure: "fail-parent"
});
```

Initial policies:

```ts
type ChildFailurePolicy =
  | "fail-parent"
  | "return-error";
```

`fail-parent` SHOULD be the default for an awaited child.

---

## 9.3 Retries

Child executions MUST have independent retry policies.

Example:

```ts
await ctx.agent("researcher", input, {
  retry: {
    attempts: 3,
    backoff: "exponential"
  }
});
```

Retrying a child MUST NOT restart its parent.

Retry state MUST survive process failure.

---

# 10. Cancellation

## 10.1 Cancellation Propagation

Parent cancellation MUST have explicit child semantics.

Supported policies SHOULD include:

```ts
type CancellationPolicy =
  | "propagate"
  | "detach";
```

Default:

```text
propagate
```

---

## 10.2 Propagated Cancellation

Given:

```text
Parent
   |
   +-- Child A
   |
   +-- Child B
          |
          +-- Grandchild C
```

Cancelling the parent with `propagate` MUST eventually cancel:

```text
Child A
Child B
Grandchild C
```

Cancellation MUST be persisted.

---

## 10.3 Detached Children

A detached child MAY continue after its parent reaches a terminal state if explicitly configured.

Example:

```ts
await ctx.startWorkflow("audit-log-export", input, {
  cancellation: "detach"
});
```

Detached execution MUST retain its original root and parent metadata for traceability.

---

# 11. Timeouts

Child execution SHOULD support timeout policies.

Example:

```ts
await ctx.agent("researcher", input, {
  timeout: "5m"
});
```

Timeout state MUST be durable.

The timeout SHOULD result in a defined terminal state/error that the parent can handle.

Timeout propagation to descendants MUST follow documented lifecycle rules.

---

# 12. Durable Execution Requirements

## 12.1 Crash Recovery

Consider:

```text
Parent
   |
   +-- Agent A      COMPLETE
   +-- Agent B      RUNNING
   +-- Agent C      COMPLETE
```

If Drassos stops and restarts:

- Agent A MUST NOT run again.
- Agent C MUST NOT run again.
- Agent B MUST resume/retry according to existing durable execution semantics.
- Parent MUST continue waiting.
- Parent MUST resume once its required children complete.

---

## 12.2 Durable Child Creation

Child creation MUST be recorded before execution begins.

The system MUST prevent a crash between "deciding to create a child" and persistence from causing uncontrolled duplicate executions.

Child scheduling MUST use the durable command/history mechanisms introduced by earlier versions.

---

## 12.3 Deterministic Replay

Replay MUST return previously recorded child execution IDs/results rather than create new children for already-recorded orchestration commands.

---

# 13. Execution Tree

Drassos MUST expose an API for retrieving execution relationships.

Example:

```ts
const tree = await runtime.getExecutionTree(executionId);
```

Suggested structure:

```ts
interface ExecutionNode {
  executionId: string;
  type: "workflow" | "agent";
  name: string;
  status: ExecutionStatus;

  children: ExecutionNode[];
}
```

Example result:

```text
research-workflow [RUNNING]
|
+-- planner [COMPLETED]
|
+-- researcher [COMPLETED]
|
+-- technical-review [RUNNING]
|
+-- writer [PENDING]
```

This API will become a foundation for the v0.8 debugger/UI.

---

# 14. Execution Metadata

Each execution SHOULD expose:

```ts
interface ExecutionMetadata {
  executionId: string;

  parentExecutionId?: string;
  rootExecutionId: string;

  depth: number;

  type: "workflow" | "agent";
  name: string;

  status: ExecutionStatus;

  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}
```

Additional internal metadata MAY include:

- originating step
- retry attempt
- cancellation policy
- failure policy
- timeout
- correlation ID

---

# 15. Events

The runtime SHOULD emit internal execution lifecycle events such as:

```text
execution.created
execution.started
execution.completed
execution.failed
execution.cancelled

child.created
child.completed
child.failed

delegation.requested
delegation.accepted
delegation.rejected
```

These are internal Drassos runtime events in v0.5.

External signal/protocol interoperability remains outside this release.

---

# 16. Resource and Safety Limits

Dynamic multi-agent systems can accidentally create runaway execution trees.

Drassos SHOULD support configurable limits.

Example:

```ts
interface OrchestrationLimits {
  maxDepth?: number;
  maxChildrenPerExecution?: number;
  maxExecutionsPerTree?: number;
  maxConcurrentChildren?: number;
}
```

Defaults SHOULD be conservative but usable.

When a limit is exceeded, Drassos MUST produce an explicit orchestration error rather than silently dropping work.

---

# 17. Error Types

v0.5 SHOULD introduce specific errors such as:

```text
ChildExecutionFailedError
ChildExecutionTimeoutError
ChildExecutionCancelledError

UnknownAgentError
UnknownWorkflowError

InvalidDelegationPlanError
CircularDependencyError

ExecutionDepthExceededError
ExecutionLimitExceededError
```

Errors MUST contain enough metadata to identify the affected child execution where applicable.

---

# 18. Proposed Public APIs

The exact API may evolve during implementation, but the following capabilities are required.

## Workflow invocation

```ts
ctx.workflow(name, input, options?)
```

## Detached workflow invocation

```ts
ctx.startWorkflow(name, input, options?)
```

## Agent invocation

```ts
ctx.agent(name, input, options?)
```

## Durable fan-out

```ts
ctx.map(items, callback, options?)
```

## Execution tree

```ts
runtime.getExecutionTree(executionId)
```

## Execution lookup

```ts
runtime.getExecution(executionId)
```

## Cancellation

```ts
runtime.cancelExecution(executionId)
```

---

# 19. Suggested Invocation Options

```ts
interface ChildExecutionOptions {
  retry?: RetryPolicy;

  timeout?: Duration;

  cancellation?: "propagate" | "detach";

  onFailure?: "fail-parent" | "return-error";
}
```

These options SHOULD work consistently across workflow and agent children where applicable.

---

# 20. Persistence Model

The persistence layer MUST be capable of representing parent/child relationships.

Conceptually:

```text
executions
----------
id
type
name
status

parent_execution_id
root_execution_id
depth

created_at
started_at
completed_at
```

The exact schema remains implementation-specific.

Queries SHOULD efficiently support:

- find execution by ID
- find direct children
- find parent
- find root
- retrieve execution tree
- retrieve active descendants
- propagate cancellation

---

# 21. Human-in-the-Loop Integration

v0.5 MUST remain compatible with the human interaction primitives introduced in v0.4.

Example:

```text
Planner
   |
   +-- Research Agent
   +-- Security Agent
   +-- Cost Agent
           |
           v
       Aggregator
           |
           v
      Human Approval
           |
           v
       Final Agent
```

A workflow tree MAY remain suspended while waiting for a human signal.

Restarting Drassos MUST preserve both:

- child execution state
- pending human interaction state

---

# 22. Reference Demo

v0.5 SHOULD include a multi-agent research workflow as its primary demonstration.

## Flow

```text
Research Request
       |
       v
 Planner Agent
       |
 +-----+-------------+
 |     |             |
 v     v             v
Web  Technical     Critic
Agent   Agent        Agent
 |       |             |
 +-------+-------------+
         |
         v
    Writer Agent
         |
         v
   Human Approval
         |
         v
     Final Result
```

The planner determines the research tasks.

Multiple specialist agents run concurrently.

The writer synthesizes their results.

The workflow waits for human approval using the v0.4 signal/HITL functionality.

---

# 23. Demo Failure Scenarios

The demo MUST demonstrate durable behavior.

## Scenario A - Runtime restart

Stop Drassos while specialist agents are running.

After restart:

- completed specialists remain completed
- incomplete specialists resume/retry
- planner does not execute again unnecessarily
- writer waits for all required results

## Scenario B - Child failure

Force one specialist agent to fail.

Verify:

- configured retry occurs
- siblings do not rerun
- failure is visible in execution metadata
- parent follows its configured failure policy

## Scenario C - Human wait

Stop Drassos while awaiting approval.

Restart Drassos.

Send approval.

Workflow MUST continue.

## Scenario D - Parent cancellation

Cancel the root workflow.

Verify cancellation propagates to active descendants according to policy.

---

# 24. Testing Requirements

## Unit Tests

Tests MUST cover:

- child execution creation
- parent ID assignment
- root ID propagation
- depth calculation
- awaited child result
- detached child execution
- nested child workflow
- agent delegation
- agent-to-agent delegation
- fan-out
- fan-in
- concurrency limits
- failure policies
- retry behavior
- timeout behavior
- cancellation propagation
- detached cancellation behavior
- orchestration limits
- invalid delegation plans
- cyclic dependency detection

---

## Persistence Tests

Tests MUST verify:

- parent/child relationships survive restart
- root execution relationships survive restart
- completed child results survive restart
- cancellation state survives restart
- retry state survives restart
- waiting parents survive restart

---

## Replay Tests

Tests MUST verify:

- replay does not recreate completed children
- replay returns the same child execution ID
- replay returns persisted child results
- fan-out does not duplicate executions
- dynamic plans do not create duplicate children after replay

---

## Integration Tests

Integration tests SHOULD include:

1. workflow -> workflow
2. workflow -> agent
3. agent -> agent
4. workflow -> parallel agents
5. workflow -> child workflow -> agent
6. planner -> dynamic specialists -> aggregator
7. cancellation across multiple levels
8. runtime restart during fan-out
9. runtime restart during child retry
10. runtime restart during human approval

---

# 25. Acceptance Criteria

v0.5 is complete when all of the following are true.

### Child workflows

- [ ] A workflow can invoke another workflow.
- [ ] Child workflows receive independent execution IDs.
- [ ] Parent/child relationships are persisted.
- [ ] Parents can await child results.
- [ ] Detached child execution is supported.

### Multi-agent orchestration

- [ ] Workflows can invoke agents.
- [ ] Agents can delegate to other agents through Drassos.
- [ ] Nested delegation works.
- [ ] Parallel agents can execute independently.
- [ ] Fan-out/fan-in is durable.
- [ ] Dynamic orchestration plans are supported and validated.

### Lifecycle

- [ ] Child failures follow explicit policies.
- [ ] Children have independent retry behavior.
- [ ] Cancellation propagation works.
- [ ] Detached cancellation semantics work.
- [ ] Child timeouts are durable.

### Durability

- [ ] Execution trees survive process restart.
- [ ] Completed children are not rerun after restart.
- [ ] Waiting parents resume correctly.
- [ ] Replay does not create duplicate children.
- [ ] Dynamic fan-out remains deterministic across replay.

### Safety

- [ ] Maximum execution depth can be configured.
- [ ] Maximum child/execution counts can be configured.
- [ ] Fan-out concurrency can be limited.
- [ ] Invalid plans are rejected.

### Inspection

- [ ] Individual executions can be queried.
- [ ] Parent/root IDs are available.
- [ ] Execution trees can be retrieved programmatically.
- [ ] Lifecycle events expose child/delegation activity.

### Demo

- [ ] Multi-agent research demo works end-to-end.
- [ ] Parallel specialists are demonstrated.
- [ ] Agent-generated delegation is demonstrated.
- [ ] v0.4 human approval is demonstrated.
- [ ] Restart recovery is demonstrated.
- [ ] Failure/retry behavior is demonstrated.
- [ ] Cancellation propagation is demonstrated.

---

# 26. Definition of Done

Drassos v0.5 is done when an application can construct a hierarchical multi-agent workflow in which agents and workflows dynamically delegate work, run children concurrently, survive process failures, retry individual branches, wait for human input, and resume the overall execution without duplicating completed work.

At that point Drassos has progressed from:

```text
Durable Workflow Engine
        +
Agent Execution
```

to:

```text
Durable Hierarchical
Agent Orchestration Engine
```

This provides the orchestration foundation needed for v0.6 external agent/tool interoperability, v0.7 distributed execution, and v0.8 visual observability.
