# Drassos v0.2 Requirements

**Release:** v0.2\
**Codename:** Agentic Orchestration\
**Status:** Draft\
**Project:** Drassos --- Durable orchestration for agents, workflows,
tools, and humans

## 1. Overview

Drassos v0.2 builds on the durable execution foundation introduced in
v0.1 and makes AI agents first-class durable participants in workflow
execution.

The primary goal of v0.2 is to allow developers to construct
long-running agentic workflows in which agents can reason, invoke local
or remote tools, launch child workflows, wait for human decisions, fail,
restart, and resume without losing execution state or incorrectly
repeating completed side effects.

The release should demonstrate that Drassos is not merely a workflow
engine with an LLM task type. Agent execution itself must be modeled,
persisted, observable, and recoverable.

## 2. Release Goals

v0.2 MUST provide:

1.  First-class durable agent runs.
2.  Durable multi-turn agent loops.
3.  MCP client/tool integration.
4.  Durable MCP tool invocation.
5.  Child workflows/subworkflows.
6.  Workflow definition versioning.
7.  Detailed agent and tool observability.
8.  Improved workflow-run visualization.
9.  Resource and execution limits for agents.
10. A complete reference application demonstrating failure and recovery
    across agentic execution.

## 3. Non-Goals

The following are explicitly out of scope for v0.2:

-   Cron and scheduled workflow execution.
-   Saga/compensation primitives.
-   Workflow-version migration of already-running workflows.
-   A2A protocol support.
-   Remote agent federation.
-   Persistent long-term agent memory.
-   Semantic agent routing.
-   Multi-tenant RBAC.
-   BPMN or DMN support.
-   Additional language SDKs.
-   Distributed worker routing beyond what is required by the v0.1
    worker model.
-   Full production-grade secrets management.
-   Visual workflow authoring.

These capabilities may be considered for later releases.

------------------------------------------------------------------------

# 4. Core Concepts

## 4.1 Agent Definition

An agent definition describes the configuration used to execute an
agent.

An agent SHOULD support configuration similar to:

``` ts
const investigator = agent({
  model: "claude-sonnet",
  system: "You investigate software issues.",
  tools: [github, filesystem],

  limits: {
    maxTurns: 20,
    maxToolCalls: 50,
    timeout: "10m"
  }
});
```

An agent definition MUST be immutable for a particular
workflow-definition version.

## 4.2 Agent Run

An `AgentRun` represents one durable execution of an agent.

An AgentRun MUST have:

-   Unique ID.
-   Parent workflow-run ID.
-   Parent step or execution ID.
-   Agent definition identifier.
-   Status.
-   Start timestamp.
-   Completion timestamp.
-   Current turn number.
-   Tool-call count.
-   Model-call count.
-   Final result, if completed.
-   Failure information, if failed.
-   Execution limits.
-   Persisted event history.

Supported statuses SHOULD include:

``` text
PENDING
RUNNING
WAITING_FOR_TOOL
WAITING_FOR_HUMAN
COMPLETED
FAILED
CANCELLED
TIMED_OUT
```

## 4.3 Agent Turn

Every iteration through the agent reasoning loop MUST be represented as
an explicit durable AgentTurn.

An AgentTurn MAY contain:

-   Input messages.
-   Model request.
-   Model response.
-   Requested tool calls.
-   Tool results.
-   Usage information.
-   Timing information.
-   Errors.

Agent turns MUST survive process restarts.

## 4.4 Model Call

Each LLM invocation MUST be represented as a first-class execution
record.

The system MUST record:

-   Provider.
-   Model.
-   Agent-run ID.
-   Agent-turn ID.
-   Request timestamp.
-   Response timestamp.
-   Latency.
-   Token usage when available.
-   Stop reason.
-   Error information.
-   Retry attempts.

Sensitive content handling is addressed separately in the observability
requirements.

## 4.5 Tool Call

Every tool invocation MUST be represented as a durable ToolCall.

ToolCall records MUST include:

-   Unique ID.
-   Tool identifier.
-   Tool source/type.
-   Agent-run ID.
-   Agent-turn ID.
-   Arguments.
-   Status.
-   Attempt count.
-   Start/end timestamps.
-   Result or error.
-   Idempotency information when applicable.

Tool sources SHOULD initially include:

``` text
LOCAL
MCP
```

The data model SHOULD allow additional sources later.

------------------------------------------------------------------------

# 5. Durable Agent Execution

## 5.1 Agent Loop

Drassos MUST provide a built-in agent loop.

Conceptually:

``` text
AgentRun
   |
   +-- ModelCall
   |
   +-- ToolCall(s)
   |
   +-- ModelCall
   |
   +-- ToolCall(s)
   |
   +-- ModelCall
   |
   +-- Result
```

Application developers MUST NOT be required to manually implement this
loop for ordinary tool-using agents.

## 5.2 Durability

The agent loop MUST checkpoint execution after every externally
significant operation.

At minimum, durable boundaries MUST exist around:

-   Model calls.
-   Tool calls.
-   Human waits.
-   Child workflow launches.
-   Child workflow completion.
-   Agent completion.

If the Drassos process terminates after a completed operation has been
persisted, restarting the worker MUST NOT unnecessarily repeat that
operation.

## 5.3 Recovery

On restart, Drassos MUST determine the last durable state of an AgentRun
and resume from that point.

Examples:

``` text
Model call completed
Process crashes
Restart
=> Do not repeat model call if its completed result was durably recorded.
```

``` text
Tool call completed
Result persisted
Process crashes
Restart
=> Resume with the persisted tool result.
```

If an external operation was initiated but its completion cannot be
determined, behavior MUST follow the operation's configured
retry/idempotency policy.

## 5.4 Agent Completion

An AgentRun completes when the model produces a terminal response that
requires no further tool execution.

The final result MUST be persisted before the parent workflow proceeds.

------------------------------------------------------------------------

# 6. Agent Execution Limits

Drassos MUST allow developers to constrain agent execution.

Required limits:

``` ts
limits: {
  maxTurns?: number;
  maxToolCalls?: number;
  timeout?: Duration;
}
```

The architecture SHOULD permit future limits such as:

``` ts
maxModelCalls
maxTokens
maxCost
```

When a limit is exceeded:

1.  The AgentRun MUST terminate predictably.
2.  Its status MUST indicate the reason.
3.  The parent workflow MUST receive a typed failure.
4.  The event MUST be visible in observability tooling.

------------------------------------------------------------------------

# 7. MCP Integration

## 7.1 MCP Client

Drassos MUST provide an MCP client abstraction that can connect to MCP
servers and expose discovered tools to agents.

Example:

``` ts
const github = mcp.server({
  command: "npx",
  args: ["@modelcontextprotocol/server-github"]
});
```

The exact API may change, but MCP servers MUST be representable as
reusable Drassos resources.

## 7.2 Initial Transports

v0.2 SHOULD support:

-   Local stdio MCP servers.
-   HTTP-based MCP servers where supported by the chosen MCP
    SDK/protocol version.

Transport concerns MUST remain separated from the agent abstraction.

## 7.3 Tool Discovery

Drassos MUST:

1.  Connect to the configured MCP server.
2.  Discover available tools.
3.  Retrieve tool names, descriptions, and input schemas.
4.  Convert those tools into the internal Drassos tool representation.
5.  Make them available to configured agents.

## 7.4 MCP Tool Invocation

An MCP invocation MUST use the same durable ToolCall model as local
tools.

For example:

``` text
Agent
  |
  +-- ToolCall
        source = MCP
        server = github
        tool = get_issue
```

The AgentRun MUST NOT need special orchestration logic for MCP tools.

## 7.5 MCP Failure Handling

Drassos MUST handle:

-   Server unavailable.
-   Server process termination.
-   Connection loss.
-   Invalid tool response.
-   Tool timeout.
-   Protocol errors.
-   Tool-reported errors.

Failures MUST integrate with the normal Drassos retry policy.

## 7.6 MCP Server Lifecycle

For locally launched MCP servers, Drassos SHOULD manage:

-   Process startup.
-   Process shutdown.
-   Unexpected process termination.
-   Reconnection/restart where appropriate.

The implementation MUST avoid launching a new MCP process for every
individual tool call unless explicitly configured to do so.

------------------------------------------------------------------------

# 8. Unified Tool Model

Local and MCP tools MUST share a common internal interface.

Conceptually:

``` ts
interface Tool {
  id: string;
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}
```

The internal abstraction MUST allow future tool sources without changing
agent-loop semantics.

Potential future sources include:

``` text
HTTP
A2A
REMOTE_WORKER
PLUGIN
```

------------------------------------------------------------------------

# 9. Child Workflows

## 9.1 Starting Child Workflows

A workflow MUST be able to launch another workflow as a child.

Example:

``` ts
const result = await ctx.workflow.run(researchWorkflow, {
  repository: ctx.input.repository
});
```

## 9.2 Parent/Child Relationship

Drassos MUST persist:

-   Parent workflow-run ID.
-   Child workflow-run ID.
-   Parent execution/step that launched the child.
-   Child workflow definition and version.

## 9.3 Independent Durability

A child workflow MUST have its own:

-   State.
-   History.
-   Steps.
-   Agent runs.
-   Tool calls.
-   Retries.
-   Failure status.
-   Observability timeline.

## 9.4 Waiting

By default, invoking a child workflow SHOULD suspend the parent until
the child reaches a terminal state.

The parent wait MUST be durable.

The worker MUST NOT remain blocked in memory while waiting.

## 9.5 Results

A successfully completed child workflow MUST return its persisted result
to the parent.

## 9.6 Failure Propagation

By default, an unhandled child workflow failure SHOULD fail the calling
parent operation.

The parent workflow MUST be able to catch and handle the failure using
the normal Drassos workflow error model.

## 9.7 Cancellation

Cancellation of a parent workflow SHOULD propagate to active child
workflows by default.

The API SHOULD allow cancellation propagation to be disabled for
specific child workflows.

## 9.8 Nested Workflows

Child workflows MUST be allowed to launch their own children.

The system MUST guard against accidental recursion or unbounded nesting
through configurable limits or clear operational protections.

------------------------------------------------------------------------

# 10. Workflow Definition Versioning

## 10.1 Versioned Definitions

Every workflow run MUST reference an immutable workflow-definition
version.

Conceptually:

``` text
WorkflowDefinition
  id: refund-process
  version: 7

WorkflowRun
  workflowId: refund-process
  workflowVersion: 7
```

## 10.2 Deployment Behavior

Deploying a new workflow version MUST NOT silently change the definition
associated with an existing WorkflowRun.

Example:

``` text
Run A -> refund-process v7

Deploy refund-process v8

Run A -> remains v7
Run B -> starts on v8
```

## 10.3 Version Identification

The implementation MAY use:

-   Explicit developer-defined versions.
-   Content hashes.
-   Build/deployment identifiers.
-   Another deterministic mechanism.

The selected mechanism MUST uniquely identify the executable workflow
definition associated with a run.

## 10.4 Migration

Migrating an existing run from one workflow definition version to
another is NOT required in v0.2.

The persisted data model MUST avoid preventing migration support in a
future release.

------------------------------------------------------------------------

# 11. Observability

## 11.1 Workflow Timeline

The Drassos console MUST display a hierarchical execution timeline.

Example:

``` text
Issue Resolution Workflow                  RUNNING

+ Workflow started

+ Triage Agent                             COMPLETED
    + Model call                           1.8s
    + MCP: github.get_issue                230ms
    + MCP: github.get_file                 182ms
    + Model call                           2.1s

+ Coding Workflow                          RUNNING
    + Coding Agent                         RUNNING
        + Model call                       3.2s
        + Tool: filesystem.write_file      40ms
        + Tool: shell.run_tests            RUNNING

+ Human Approval                           PENDING
```

## 11.2 Agent Run Detail

Selecting an AgentRun MUST show:

-   Agent identity/configuration.
-   Status.
-   Start/end time.
-   Duration.
-   Turn count.
-   Model-call count.
-   Tool-call count.
-   Execution limits.
-   Final result or failure.

## 11.3 Agent Turn Detail

Each turn SHOULD expose:

-   Messages supplied to the model.
-   Model response.
-   Requested tool calls.
-   Tool results.
-   Timing.
-   Usage.

## 11.4 Model Call Detail

The console SHOULD expose:

-   Provider.
-   Model.
-   Input.
-   Output.
-   Token usage.
-   Latency.
-   Retry attempts.
-   Stop reason.
-   Errors.

## 11.5 Tool Call Detail

The console MUST expose:

-   Tool.
-   Tool source.
-   MCP server when applicable.
-   Arguments.
-   Result.
-   Status.
-   Duration.
-   Attempts.
-   Errors.

## 11.6 Child Workflow Navigation

A parent workflow timeline MUST identify child workflows.

Users MUST be able to navigate from the parent run to the child run and
back.

------------------------------------------------------------------------

# 12. Sensitive Data and Observability

Prompts, model responses, and tool arguments/results may contain secrets
or sensitive application data.

v0.2 MUST therefore provide a mechanism for applications to disable or
redact persisted payloads.

At minimum, configuration SHOULD support behavior equivalent to:

``` ts
observability: {
  recordPrompts: true,
  recordResponses: true,
  recordToolArguments: true,
  recordToolResults: true
}
```

Applications MUST be able to disable these individually.

The data model SHOULD distinguish operational metadata from potentially
sensitive payload data.

Secret values from Drassos configuration MUST NOT be accidentally
persisted into execution history.

------------------------------------------------------------------------

# 13. Event Model

v0.2 SHOULD extend the v0.1 workflow history with events similar to:

``` text
AgentRunStarted
AgentTurnStarted
ModelCallStarted
ModelCallCompleted
ModelCallFailed
ToolCallStarted
ToolCallCompleted
ToolCallFailed
AgentTurnCompleted
AgentRunCompleted
AgentRunFailed

ChildWorkflowStarted
ChildWorkflowCompleted
ChildWorkflowFailed
ChildWorkflowCancelled
```

Events MUST be immutable once committed.

Events MUST contain enough information to reconstruct the observable
execution state without depending on in-memory worker state.

------------------------------------------------------------------------

# 14. Persistence Requirements

The persistence layer MUST support durable storage for:

-   Workflow definitions and versions.
-   Workflow runs.
-   Parent/child workflow relationships.
-   Agent runs.
-   Agent turns.
-   Model calls.
-   Tool calls.
-   MCP metadata.
-   Execution events.
-   Results.
-   Failures.
-   Usage metrics where available.

Schema design MUST support efficient queries for:

-   All agent runs for a workflow run.
-   All turns for an agent run.
-   All tool calls for an agent run.
-   All model calls for an agent run.
-   Child workflows for a parent.
-   Parent workflow for a child.
-   Chronological workflow execution history.

------------------------------------------------------------------------

# 15. SDK Requirements

The TypeScript SDK MUST provide ergonomic APIs for:

-   Defining agents.
-   Configuring models.
-   Attaching local tools.
-   Attaching MCP tools.
-   Starting AgentRuns.
-   Starting child workflows.
-   Configuring execution limits.
-   Accessing agent results.
-   Handling agent failures.
-   Handling child workflow failures.

A representative workflow SHOULD be expressible approximately as:

``` ts
const github = mcp.server({
  command: "npx",
  args: ["@modelcontextprotocol/server-github"]
});

const triageAgent = agent({
  model: "claude-sonnet",
  tools: [github],
  limits: {
    maxTurns: 10,
    maxToolCalls: 20,
    timeout: "5m"
  }
});

const investigateIssue = defineWorkflow(async (ctx) => {
  const analysis = await ctx.agent.run(triageAgent, {
    prompt: `Investigate issue ${ctx.input.issue}`
  });

  await ctx.human.approve({
    title: "Approve implementation?",
    data: analysis
  });

  return ctx.workflow.run(implementIssue, {
    analysis
  });
});
```

The exact syntax is not normative. The capabilities are.

------------------------------------------------------------------------

# 16. Provider Architecture

Agent orchestration MUST remain independent of any particular model
provider.

The v0.1 AgentProvider abstraction SHOULD be extended rather than
bypassed.

Providers SHOULD normalize:

-   Messages.
-   Tool definitions.
-   Tool-call requests.
-   Usage.
-   Stop reasons.
-   Errors.

Provider-specific data MAY be retained as optional metadata.

No core orchestration code SHOULD depend directly on OpenAI-,
Anthropic-, Google-, or other provider-specific SDK types.

------------------------------------------------------------------------

# 17. Error Handling

v0.2 MUST define typed errors for major failure categories.

Examples:

``` text
AgentLimitExceededError
AgentTimeoutError
ModelProviderError
ToolExecutionError
McpConnectionError
McpProtocolError
ChildWorkflowError
WorkflowVersionError
```

Errors MUST retain enough structured information for:

-   Workflow handling.
-   Retry decisions.
-   Console display.
-   Logging.
-   Debugging.

------------------------------------------------------------------------

# 18. Retry Semantics

Model calls and tool calls MUST use explicit retry policies.

Retry policy SHOULD support:

``` ts
retry: {
  maxAttempts: 3,
  backoff: "exponential",
  initialDelay: "1s",
  maxDelay: "30s"
}
```

Retry attempts MUST be visible in execution history.

Retries MUST NOT cause a successfully persisted external operation to
execute again merely because the worker restarted.

------------------------------------------------------------------------

# 19. Cancellation

Cancellation MUST work through the new v0.2 execution hierarchy.

Conceptually:

``` text
WorkflowRun
   |
   +-- AgentRun
   |     +-- ModelCall
   |     +-- ToolCall
   |
   +-- ChildWorkflow
         +-- AgentRun
```

Cancelling a workflow SHOULD propagate to:

-   Active AgentRuns.
-   Active child workflows.
-   Pending tool operations where cancellation is supported.

Cancellation state MUST be persisted.

------------------------------------------------------------------------

# 20. CLI

The CLI SHOULD be extended with commands for inspecting v0.2 resources.

Potential commands:

``` bash
drassos runs show <run-id>
drassos runs history <run-id>

drassos agents list <run-id>
drassos agents show <agent-run-id>

drassos tools show <tool-call-id>

drassos workflows children <run-id>
```

Exact command names may differ.

CLI output MUST be usable without the web console.

------------------------------------------------------------------------

# 21. Console

The v0.2 console MUST support:

-   Workflow-run list.
-   Workflow-run detail.
-   Hierarchical timeline.
-   Agent-run inspection.
-   Agent-turn inspection.
-   Model-call inspection.
-   Tool-call inspection.
-   Child-workflow navigation.
-   Error/retry visibility.
-   Execution duration.
-   Token usage when available.

The console is an operational/debugging interface, not a visual workflow
designer.

------------------------------------------------------------------------

# 22. Testing Requirements

## 22.1 Agent Recovery Tests

Tests MUST simulate process termination:

1.  Before a model call.
2.  After a model response is persisted.
3.  Before a tool call.
4.  After a tool result is persisted.
5.  Between agent turns.
6.  Immediately before agent completion.
7.  Immediately after agent completion.

The AgentRun MUST resume correctly in each scenario.

## 22.2 MCP Tests

Tests MUST cover:

-   MCP discovery.
-   Successful invocation.
-   Invalid arguments.
-   Tool error.
-   Server unavailable.
-   Server termination.
-   Timeout.
-   Reconnection/restart.
-   Multiple calls to the same server.
-   Concurrent MCP calls where supported.

## 22.3 Child Workflow Tests

Tests MUST cover:

-   Successful child completion.
-   Child failure.
-   Parent failure.
-   Parent cancellation.
-   Child cancellation.
-   Nested children.
-   Worker restart while parent waits.
-   Worker restart while child executes.

## 22.4 Versioning Tests

Tests MUST verify:

1.  A run starts on workflow v1.
2.  Workflow v2 is deployed.
3.  The existing run remains associated with v1.
4.  A new run uses v2.

## 22.5 Agent Limit Tests

Tests MUST cover:

-   Maximum turns.
-   Maximum tool calls.
-   Timeout.
-   Successful completion immediately before a limit.
-   Correct typed failure after exceeding a limit.

------------------------------------------------------------------------

# 23. Reference Application

v0.2 MUST include a reference application demonstrating the complete
agentic orchestration model.

## 23.1 GitHub Issue Resolution Demo

Recommended workflow:

``` text
GitHub Issue
     |
     v
Triage Agent
     |
     +-- MCP: inspect issue
     +-- MCP: inspect repository
     |
     v
Research Child Workflow
     |
     +-- Research Agent
     |
     v
Coding Agent
     |
     +-- Read files
     +-- Modify files
     +-- Run tests
     |
     +---- tests fail ----+
     |                    |
     +<-------------------+
     |
     v
Human Approval
     |
     v
Create Pull Request
```

## 23.2 Demo Requirements

The demo MUST show:

-   Multiple agent turns.
-   MCP tool usage.
-   At least one child workflow.
-   Human approval.
-   Local or MCP tool execution.
-   Durable workflow state.
-   Detailed console history.

## 23.3 Failure Demonstration

The demo MUST support deliberately terminating the Drassos worker during
execution.

After restart:

-   The workflow MUST resume.
-   Completed durable operations MUST remain completed.
-   Unsafe side effects MUST NOT be blindly repeated.
-   The console MUST show the pre- and post-restart execution as one
    continuous workflow history.

This is the primary acceptance demonstration for v0.2.

------------------------------------------------------------------------

# 24. Acceptance Criteria

Drassos v0.2 is complete when all of the following are true:

-   [ ] Developers can define first-class agents.
-   [ ] Agents can execute multi-turn tool-use loops.
-   [ ] Agent state survives worker/process restarts.
-   [ ] Model calls are persisted and observable.
-   [ ] Tool calls are persisted and observable.
-   [ ] Agent execution limits are enforced.
-   [ ] Agents can consume local tools.
-   [ ] Agents can consume MCP tools.
-   [ ] MCP tool discovery works.
-   [ ] MCP failures integrate with Drassos retries/errors.
-   [ ] Workflows can invoke child workflows.
-   [ ] Parent/child relationships are persisted.
-   [ ] Parent workflows durably wait for children.
-   [ ] Cancellation propagates correctly.
-   [ ] Workflow runs are pinned to immutable definition versions.
-   [ ] Existing runs are unaffected by deployment of newer definitions.
-   [ ] The console exposes hierarchical workflow/agent/tool execution.
-   [ ] Sensitive payload recording can be disabled.
-   [ ] CLI inspection works for the new execution entities.
-   [ ] Crash/recovery integration tests pass.
-   [ ] The GitHub issue-resolution reference application works
    end-to-end.
-   [ ] Killing and restarting Drassos during the reference workflow
    demonstrates correct durable recovery.

------------------------------------------------------------------------

# 25. Suggested Implementation Order

The recommended implementation sequence is:

### Phase 1 --- Execution Model

1.  Add AgentRun persistence.
2.  Add AgentTurn persistence.
3.  Add ModelCall persistence.
4.  Generalize ToolCall persistence.
5.  Add execution events.
6.  Implement durable agent loop.

### Phase 2 --- Agent Controls

1.  Turn limits.
2.  Tool-call limits.
3.  Agent timeout.
4.  Retry policies.
5.  Cancellation.

### Phase 3 --- MCP

1.  MCP client abstraction.
2.  stdio transport.
3.  Tool discovery.
4.  Tool adapter.
5.  Durable MCP invocation.
6.  MCP lifecycle management.
7.  HTTP transport if applicable.

### Phase 4 --- Child Workflows

1.  Parent/child persistence.
2.  Child invocation API.
3.  Durable parent waiting.
4.  Result propagation.
5.  Failure propagation.
6.  Cancellation propagation.

### Phase 5 --- Versioning

1.  Workflow-definition records.
2.  Immutable definition versions.
3.  Run/version association.
4.  Deployment behavior.

### Phase 6 --- Observability

1.  Agent timeline.
2.  Turn detail.
3.  Model-call detail.
4.  Tool-call detail.
5.  Child-workflow navigation.
6.  Usage/latency display.
7.  Sensitive-payload controls.

### Phase 7 --- Reference Application

1.  GitHub MCP integration.
2.  Triage agent.
3.  Research child workflow.
4.  Coding/test loop.
5.  Human approval.
6.  Pull-request creation.
7.  Forced-crash demo.
8.  End-to-end tests.

------------------------------------------------------------------------

# 26. Definition of Done

v0.2 is not considered complete merely because an LLM can call MCP
tools.

The release is complete when Drassos can execute a multi-agent,
multi-tool, multi-workflow process in which:

-   Agent reasoning is durable.
-   Individual model and tool operations are observable.
-   Child workflows are independently durable.
-   Human waits remain durable.
-   Execution can survive process failure.
-   Workflow versions remain stable across deployments.
-   Operators can understand exactly what occurred through the console
    and CLI.

The defining property of Drassos v0.2 should be:

> **Agents, tools, humans, and workflows are durable first-class
> participants in one observable execution model.**
