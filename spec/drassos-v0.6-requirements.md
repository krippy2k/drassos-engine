# Drassos v0.6 Requirements — Interoperability

**Version:** 0.6  
**Status:** Planned  
**Theme:** MCP + external agent/tool interoperability  

## 1. Overview

Drassos v0.6 adds interoperability between the Drassos runtime and external agent/tool ecosystems.

By the end of v0.6, Drassos must be able to:

- Consume tools exposed by external MCP servers.
- Expose Drassos tools and workflows through an MCP server.
- Invoke external agents through A2A-compatible interfaces.
- Expose selected Drassos agents through an A2A-compatible interface.
- Represent local and remote executable capabilities through a common internal abstraction.
- Preserve Drassos durability semantics when external operations participate in workflows.

v0.6 should make protocol integrations adapters around the Drassos execution model rather than embedding MCP- or A2A-specific behavior throughout the workflow runtime.

---

## 2. Goals

### 2.1 Primary Goals

1. Add an MCP client implementation.
2. Add an MCP server implementation.
3. Add an A2A client implementation for remote agents.
4. Add an A2A server/gateway for exposing Drassos agents.
5. Introduce a unified capability abstraction for local and remote execution.
6. Integrate remote calls with durable workflow execution.
7. Provide consistent timeout, cancellation, retry, and error semantics.
8. Provide authentication/configuration extension points without coupling the core runtime to a specific identity provider.
9. Maintain strong separation between protocol adapters and core orchestration.

### 2.2 Non-Goals

The following are explicitly outside v0.6:

- Distributed worker fleets.
- Worker sharding or partitioning.
- High-availability coordinators.
- Production-scale distributed scheduling.
- Full workflow debugger/UI.
- Visual workflow designer.
- Full observability product/dashboard.
- A generic API gateway product.
- Supporting every optional feature of MCP or A2A in the first release.

These belong primarily to v0.7 and v0.8 or later releases.

---

## 3. Architecture Principles

### 3.1 Protocol Isolation

The workflow engine must not directly depend on MCP or A2A concepts.

Protocol-specific behavior should live behind adapters:

```text
                  Drassos Runtime
                        |
                 Capability API
                        |
          +-------------+-------------+
          |             |             |
          v             v             v
       Local         MCP Adapter    A2A Adapter
    Capability          |             |
                        v             v
                   MCP Server     Remote Agent
```

### 3.2 Durable Boundary

Any external operation that can outlive the current process must have enough persisted state to recover safely after a restart.

Drassos must never rely exclusively on an in-memory Promise to represent durable external work.

### 3.3 Explicit Capability Types

Tools, agents, and workflows have different semantics even when they share a common invocation mechanism. The common abstraction must not erase useful type information.

### 3.4 Adapter Extensibility

Future protocols should be implementable without rewriting the workflow runtime.

---

## 4. Unified Capability Model

Introduce a core capability abstraction.

Example conceptual API:

```ts
export type CapabilityKind = "tool" | "agent" | "workflow";
export type CapabilitySource = "local" | "mcp" | "a2a";

export interface Capability<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  kind: CapabilityKind;
  source: CapabilitySource;

  invoke(
    input: TInput,
    context: CapabilityExecutionContext
  ): Promise<CapabilityResult<TOutput>>;
}
```

### 4.1 Requirements

The capability model must support:

- Stable capability identifiers.
- Human-readable names/descriptions.
- Capability kind.
- Capability source/provider.
- Input schema when available.
- Output schema when available.
- Invocation metadata.
- Timeout configuration.
- Cancellation.
- Retry policy integration.
- Authentication/configuration references.
- Structured errors.

### 4.2 Capability Registry

Provide a registry capable of resolving capabilities by stable ID.

Example:

```ts
registry.register(localTool);
registry.register(mcpTool);
registry.register(remoteAgent);

const capability = registry.get("github:get_pull_request");
```

The registry should allow providers/adapters to dynamically register discovered capabilities.

---

## 5. MCP Client

Drassos agents and workflows must be able to consume external MCP servers.

### 5.1 Server Configuration

Provide a declarative server configuration API.

Example:

```ts
const github = mcpServer({
  name: "github",
  transport: {
    type: "http",
    url: process.env.GITHUB_MCP_URL!
  }
});
```

Configuration should support:

- Server name/ID.
- Transport configuration.
- Endpoint/process configuration as appropriate for supported transports.
- Authentication configuration.
- Connection/request timeout.
- Retry policy.
- Optional capability allowlist/denylist.

Secrets must not be persisted directly in workflow history.

### 5.2 Connection Lifecycle

The MCP client must support:

- Initialization.
- Capability negotiation.
- Connection establishment where required by the transport.
- Graceful shutdown.
- Connection failure handling.
- Reconnection where appropriate.

### 5.3 Tool Discovery

Drassos must be able to discover tools exposed by an MCP server and translate them into Drassos capabilities.

Example:

```ts
const tools = await github.tools();
```

And preferably:

```ts
const getPullRequest = github.tool("get_pull_request");
```

Each discovered tool should expose:

- Name.
- Description.
- Input schema.
- Provider/server identity.
- Stable Drassos capability ID.

### 5.4 Tool Invocation

An MCP-backed tool should be usable similarly to a native Drassos tool.

```ts
const result = await ctx.tool(github.tool("get_pull_request")).run({
  owner: "example",
  repo: "example",
  pullNumber: 42
});
```

Drassos must translate:

```text
Drassos invocation
      -> MCP request
      -> MCP result/error
      -> Drassos capability result
```

### 5.5 MCP Errors

Protocol/transport errors must be converted into structured Drassos errors while retaining useful protocol metadata.

Errors should distinguish at minimum:

- Connection failure.
- Authentication/authorization failure.
- Unknown tool.
- Invalid arguments.
- Remote execution failure.
- Timeout.
- Cancellation.
- Protocol violation.

---

## 6. MCP Server

Drassos must be able to expose selected capabilities to external MCP clients.

### 6.1 Server API

Example conceptual API:

```ts
const server = createMcpServer({
  name: "drassos"
});

server.tool("research-company", {
  workflow: researchCompanyWorkflow
});

server.tool("lookup-customer", {
  tool: lookupCustomerTool
});

await server.listen();
```

### 6.2 Exposable Capabilities

v0.6 must support exposing:

- Drassos tools.
- Drassos workflows.

Agent exposure should primarily use A2A rather than pretending every agent is an MCP tool.

### 6.3 Schema Mapping

Drassos must translate capability schemas into MCP-compatible tool schemas.

Validation must occur before starting execution where possible.

### 6.4 Workflow-Backed MCP Tools

An MCP invocation may start a durable Drassos workflow.

```text
MCP Client
    |
    v
Drassos MCP Server
    |
    v
Workflow Instance
    |
    +--> Tool
    +--> Agent
    +--> Human Approval
    +--> Child Workflow
```

The adapter must clearly distinguish operations that can complete synchronously from operations that require durable/asynchronous lifecycle handling.

### 6.5 Durable Long-Running Operations

Where supported by the selected MCP protocol features, Drassos should map long-running MCP task lifecycle semantics onto workflow instances.

Persist at minimum:

- External request/task identity.
- Workflow instance ID.
- Current external operation state.
- Completion/failure state.
- Correlation metadata required to resume/retrieve the result.

A process restart must not silently lose a previously accepted durable invocation.

---

## 7. A2A Client / Remote Agents

Drassos must support invoking compatible external agents.

### 7.1 Remote Agent Definition

Example:

```ts
const researcher = a2aAgent({
  name: "researcher",
  url: "https://agents.example.com/researcher"
});
```

### 7.2 Agent Discovery

Where supported by A2A, Drassos should discover and parse the remote Agent Card and relevant capabilities.

Store normalized metadata such as:

- Agent identity.
- Description.
- Endpoint.
- Skills/capabilities.
- Supported protocol/binding information.
- Authentication requirements where discoverable.

### 7.3 Agent Invocation

Remote agents should integrate with the Drassos agent execution model.

Example:

```ts
const result = await ctx.agent(researcher).run({
  task: "Research the semiconductor market"
});
```

### 7.4 Task Lifecycle

Support the core remote task lifecycle required for useful orchestration:

- Create/send task/message.
- Receive task identity.
- Query task status/result when applicable.
- Receive successful completion.
- Receive failure.
- Cancel work where supported.

Streaming support may be included if it can be implemented cleanly, but durable non-streaming execution is higher priority for v0.6.

### 7.5 Durable Remote Agent Calls

Drassos must persist enough information to recover a remote-agent operation.

Example persisted data:

```ts
interface RemoteAgentExecutionState {
  provider: "a2a";
  agentId: string;
  remoteTaskId?: string;
  endpointRef: string;
  status: string;
  startedAt: string;
}
```

Secrets or bearer tokens must not be serialized into workflow state/history.

After restart, Drassos must be able to determine whether it should:

- Resume polling/retrieval.
- Reconnect to an existing task.
- Mark the operation failed if recovery is impossible.

It must not blindly create duplicate remote work.

---

## 8. A2A Server / Drassos Agent Gateway

Selected Drassos agents must be exposable to external agents through A2A.

Example:

```ts
const gateway = createA2AServer({
  name: "drassos-agents"
});

gateway.agent(researchAgent);
gateway.agent(codeReviewAgent);

await gateway.listen();
```

### 8.1 Agent Card

The gateway must expose appropriate agent metadata for discoverability.

### 8.2 Incoming Tasks

An incoming external task should map to a Drassos agent/workflow execution.

```text
External Agent
      |
      | A2A
      v
Drassos A2A Gateway
      |
      v
Drassos Agent
      |
      v
Durable Execution
```

### 8.3 Correlation

Persist mappings between:

```text
A2A task ID <-> Drassos execution/workflow ID
```

This mapping must survive restart.

### 8.4 Status and Results

External callers must be able to retrieve an appropriate representation of:

- Submitted/running state.
- Waiting state when representable.
- Completed result.
- Failure.
- Cancellation.

Internal Drassos implementation details must not leak unnecessarily through the protocol boundary.

---

## 9. Authentication and Authorization

v0.6 does not need to become a full identity platform, but protocol adapters must have proper security extension points.

### 9.1 Outbound Authentication

External MCP/A2A definitions must support references to authentication providers/configuration.

Example:

```ts
mcpServer({
  name: "private-tools",
  transport: { ... },
  auth: secretRef("private-tools-token")
});
```

Do not serialize resolved credentials into durable workflow history.

### 9.2 Inbound Authentication

MCP and A2A servers must provide middleware/hooks for validating incoming identities.

### 9.3 Authorization

Applications must be able to control which capabilities are externally exposed and which callers may invoke them.

Default behavior should be deny-by-default for external exposure.

---

## 10. Timeouts, Retries, Cancellation, and Idempotency

External calls introduce failure modes that local operations do not.

### 10.1 Timeouts

Each external capability invocation must support configurable timeout behavior.

### 10.2 Retries

Retries must integrate with Drassos retry policies.

Retry decisions should distinguish transient transport errors from permanent protocol/application errors.

### 10.3 Idempotency

Drassos must not assume that retrying an external operation is safe.

Adapters should use protocol-supported task/request identifiers and idempotency mechanisms when available.

### 10.4 Cancellation

Cancellation should propagate to the remote system when supported.

Failure to cancel remotely must be recorded and surfaced rather than treated as successful cancellation.

---

## 11. Workflow History and Events

External capability execution must generate normalized Drassos events.

Suggested events:

```text
CapabilityInvocationStarted
CapabilityInvocationCompleted
CapabilityInvocationFailed
CapabilityInvocationCancelled
RemoteTaskCreated
RemoteTaskStatusChanged
RemoteTaskRecovered
```

Events should contain normalized metadata plus optional protocol-specific diagnostic metadata.

Do not persist secrets.

---

## 12. Observability Hooks

Full observability UI belongs to v0.8, but v0.6 must expose enough structured information for later tracing.

Each invocation should carry/correlate:

- Workflow ID.
- Execution/run ID.
- Capability ID.
- Provider/protocol.
- Remote task/request ID where available.
- Attempt number.
- Start/end timestamps.
- Result status.

Protocol adapters should provide hooks for logging/tracing without requiring a specific telemetry vendor.

---

## 13. Public API Examples

### 13.1 Using an MCP Tool from an Agent

```ts
const github = mcpServer({
  name: "github",
  transport: {
    type: "http",
    url: process.env.GITHUB_MCP_URL!
  }
});

const reviewer = defineAgent({
  name: "reviewer",
  tools: [
    github.tool("get_pull_request"),
    github.tool("get_file")
  ]
});
```

### 13.2 Using an External Agent

```ts
const researcher = a2aAgent({
  name: "researcher",
  url: process.env.RESEARCH_AGENT_URL!
});

const workflow = defineWorkflow({
  name: "market-research",

  async run(ctx, input) {
    return ctx.agent(researcher).run({
      task: `Research ${input.market}`
    });
  }
});
```

### 13.3 Exposing a Workflow via MCP

```ts
const mcp = createMcpServer({ name: "drassos" });

mcp.tool("market-research", {
  workflow: marketResearchWorkflow
});

await mcp.listen();
```

### 13.4 Exposing an Agent via A2A

```ts
const a2a = createA2AServer({ name: "drassos" });

a2a.agent(researchAgent);

await a2a.listen();
```

---

## 14. Persistence Requirements

Any durable external operation must persist sufficient normalized state for recovery.

Persistence must include, where applicable:

- Capability ID.
- Provider type.
- External server/agent configuration reference.
- External task/request ID.
- Drassos execution ID.
- Current state.
- Retry/attempt state.
- Correlation metadata.

Persistence must not include resolved credentials.

Protocol-specific persisted state should be versioned so adapters can evolve without silently breaking existing executions.

---

## 15. Recovery Requirements

On runtime restart:

1. Load incomplete executions.
2. Identify pending external operations.
3. Reconstruct the appropriate capability adapter.
4. Use persisted correlation/task information to recover remote state.
5. Continue the workflow when the remote operation completes.
6. Avoid duplicate invocation unless the operation is explicitly known to be safe to retry.

Recovery behavior must be covered by integration tests.

---

## 16. Testing Requirements

### 16.1 Unit Tests

Test:

- Capability registry.
- Schema translation.
- MCP result normalization.
- A2A result normalization.
- Error translation.
- Authentication reference handling.
- Retry classification.
- Persistence serialization.
- Recovery decision logic.

### 16.2 MCP Integration Tests

Provide a test MCP server and verify:

- Discovery.
- Tool invocation.
- Invalid input.
- Remote failure.
- Timeout.
- Cancellation where supported.
- Authentication hooks.

### 16.3 MCP Server Tests

Verify an external/test MCP client can:

- Discover exposed Drassos tools.
- Invoke a native Drassos tool.
- Invoke a workflow-backed tool.
- Receive failures correctly.
- Complete a durable/long-running invocation where supported.

### 16.4 A2A Integration Tests

Provide a test external agent and verify:

- Discovery/Agent Card parsing.
- Task submission.
- Status/result retrieval.
- Failure handling.
- Cancellation where supported.
- Recovery after Drassos restart.

### 16.5 A2A Server Tests

Verify a test external agent/client can:

- Discover an exposed Drassos agent.
- Submit work.
- Retrieve state/result.
- Cancel where supported.
- Retrieve the final result after a Drassos process restart.

### 16.6 Restart Tests

Restart tests are mandatory for v0.6.

At minimum:

```text
Start workflow
   |
Invoke external capability
   |
Remote work remains active
   |
Kill Drassos process
   |
Restart Drassos
   |
Recover remote operation
   |
Receive result
   |
Continue workflow
   |
Complete
```

The test must verify the remote operation was not unintentionally duplicated.

---

## 17. Example Acceptance Scenario

The primary v0.6 demo should execute a workflow containing all major execution types:

```text
Drassos Workflow
      |
      +--> Local Tool
      |
      +--> MCP Tool --------> External MCP Server
      |
      +--> Local Agent
      |
      +--> A2A Agent -------> External Agent
      |
      +--> Human Approval
      |
      +--> Child Workflow
      |
      v
   Complete
```

During one external operation, terminate and restart Drassos.

The workflow must recover and finish without duplicating completed work.

A second acceptance scenario must demonstrate inbound interoperability:

```text
External MCP Client
        |
        v
Drassos MCP Server
        |
        v
Durable Workflow
        |
        +--> Agent
        +--> External Capability
        +--> Human Approval
        |
        v
      Result
```

An A2A equivalent should demonstrate an external agent invoking a Drassos-hosted agent.

---

## 18. Acceptance Criteria

v0.6 is complete when:

- [ ] Drassos can connect to a supported external MCP server.
- [ ] MCP tools can be discovered and represented as Drassos capabilities.
- [ ] Workflows and agents can invoke MCP tools.
- [ ] Selected Drassos tools can be exposed through MCP.
- [ ] Selected Drassos workflows can be exposed through MCP.
- [ ] Drassos can discover/configure an A2A-compatible external agent.
- [ ] A workflow can invoke an external agent.
- [ ] Remote agent task state is correlated with Drassos execution state.
- [ ] Selected Drassos agents can be exposed through A2A.
- [ ] External A2A callers can retrieve execution results.
- [ ] Local, MCP, and A2A execution use a common capability abstraction.
- [ ] External operations support structured timeout/error behavior.
- [ ] Cancellation propagates where supported.
- [ ] Credentials are not persisted in workflow history.
- [ ] Long-running external operations survive Drassos restart where the remote protocol provides recoverable identity/state.
- [ ] Recovery does not blindly duplicate remote work.
- [ ] Integration tests cover MCP client/server behavior.
- [ ] Integration tests cover A2A client/server behavior.
- [ ] Restart/recovery integration tests pass.
- [ ] Existing v0.1-v0.5 behavior remains backward compatible unless explicitly documented.

---

## 19. Suggested Implementation Phases

### Phase 1 — Capability Foundation

Implement:

- Capability interface.
- Capability registry.
- Normalized results/errors.
- Provider metadata.
- Execution events.

### Phase 2 — MCP Client

Implement:

- MCP server configuration.
- Connection lifecycle.
- Tool discovery.
- Tool invocation.
- Schema/result/error translation.

### Phase 3 — MCP Server

Implement:

- Server transport.
- Tool registration.
- Drassos tool exposure.
- Workflow exposure.
- Durable task/workflow correlation where applicable.

### Phase 4 — A2A Client

Implement:

- Remote agent definition.
- Agent Card discovery.
- Task submission.
- Status/result retrieval.
- Cancellation.
- Durable correlation/recovery.

### Phase 5 — A2A Server

Implement:

- Agent discovery metadata.
- Incoming task handling.
- Drassos agent execution mapping.
- Persistent task correlation.
- Status/result endpoints/bindings.

### Phase 6 — Security and Reliability

Implement/harden:

- Authentication providers/references.
- Authorization hooks.
- Timeout handling.
- Retry classification.
- Idempotency safeguards.
- Cancellation propagation.

### Phase 7 — Recovery and Acceptance Demo

Implement and verify:

- Restart recovery.
- No-duplicate guarantees where recoverable.
- Full interoperability acceptance workflow.
- Documentation/examples.

---

## 20. Definition of Done

Drassos v0.6 is done when Drassos is no longer an isolated orchestration runtime.

It must be capable of consuming external tools, delegating work to external agents, and exposing its own durable tools/workflows/agents through standard interoperability boundaries while preserving Drassos's core execution properties.

The key architectural outcome is:

> **Drassos orchestrates capabilities regardless of whether they execute locally, through MCP, or as remote agents through A2A.**

This foundation should allow future protocols and providers to be added as adapters without redesigning the workflow engine.
