# Drassos v0.3 Requirements

**Version:** v0.3  
**Codename:** Agent Tasks & Tool Execution  
**Status:** Planned

## 1. Overview

Drassos v0.3 introduces first-class AI agent execution to the durable workflow engine.

The objective is to allow a Drassos workflow to invoke a bounded AI agent task, allow that agent to make one or more model calls and tool calls, persist the execution history, survive process restarts, and return a structured result to deterministic workflow logic.

The workflow engine remains responsible for orchestration, durability, retries, cancellation, state, and lifecycle. Agents are nondeterministic workers operating inside bounded workflow tasks; they do not replace the workflow engine.

## 2. Goals

v0.3 MUST:

1. Add an `agent` task as a first-class workflow primitive.
2. Introduce a model-provider abstraction that is not tied to one LLM vendor.
3. Provide an application-level tool registry.
4. Allow agents to receive an explicit subset of registered tools.
5. Support multi-turn model/tool execution loops.
6. Persist agent, model, and tool execution state.
7. Resume interrupted agent executions after process restart.
8. Avoid re-running already completed tool calls during recovery.
9. Support structured agent output validated against a schema.
10. Provide configurable execution limits.
11. Record sufficient execution history for future observability and debugging.

## 3. Non-Goals

The following are explicitly out of scope for v0.3:

- MCP servers or MCP clients
- A2A protocol support
- Multi-agent coordination
- Human approval tasks
- Visual workflow editing
- Distributed worker infrastructure
- Production-grade tracing dashboards
- Token/cost dashboards
- Agent memory across independent workflow executions
- Autonomous agents controlling the workflow lifecycle
- Dynamic creation of arbitrary workflow topology by an agent

These capabilities may build on the primitives introduced in v0.3.

## 4. Architectural Principles

### 4.1 Workflow Engine Owns Control Flow

Drassos MUST remain the authority over:

- workflow lifecycle
- persistence
- retries
- cancellation
- branching
- timers
- recovery
- task scheduling

An agent MAY reason and invoke tools inside an agent task, but MUST NOT directly assume ownership of the surrounding workflow.

Conceptually:

```text
Workflow Engine
      |
      +-- Activity
      |
      +-- Agent Task
      |     |
      |     +-- Model Call
      |     +-- Tool Call
      |     +-- Model Call
      |     +-- Tool Call
      |     +-- Model Call
      |     +-- Result
      |
      +-- Decision
      |
      +-- Activity
```

### 4.2 Agent Execution Is Bounded

Every agent execution MUST have defined limits.

At minimum Drassos MUST support:

- maximum turns
- maximum tool calls
- execution timeout

The runtime MUST terminate an execution that exceeds its configured limits.

### 4.3 External Effects Are Durable Boundaries

Tool calls may perform external side effects.

Drassos MUST persist the lifecycle of a tool call so recovery can distinguish:

- requested
- started
- completed
- failed

A completed tool call MUST NOT be automatically repeated during normal workflow recovery.

Drassos MUST NOT claim exactly-once execution for arbitrary external side effects. Tool APIs SHOULD support idempotency where applicable.

## 5. Agent Task API

The workflow SDK MUST expose an API conceptually similar to:

```ts
const result = await workflow.agent("researchRestaurant", {
  model: "openai:gpt-5.6",
  prompt: "Find a restaurant suitable for this group.",
  tools: ["searchRestaurants", "getMenu"],
  maxTurns: 10,
  maxToolCalls: 20,
  timeout: "5m"
});
```

The exact API may evolve during implementation.

### 5.1 Agent Task Definition

An agent task SHOULD support:

```ts
interface AgentTaskOptions<TOutput = unknown> {
  model: string;
  prompt: string;
  tools?: string[];
  output?: Schema<TOutput>;
  maxTurns?: number;
  maxToolCalls?: number;
  timeout?: Duration;
}
```

The runtime MUST assign every agent execution a durable identifier.

### 5.2 Agent Input

Agent tasks MUST be able to consume:

- static prompt text
- workflow input
- values produced by previous workflow tasks

Prompt construction SHOULD remain application-controlled.

### 5.3 Agent Result

A completed agent task MUST return its result to the workflow.

The result MUST be persisted before the workflow proceeds to dependent work.

## 6. Model Provider Abstraction

Drassos MUST introduce an abstraction between the agent runtime and LLM providers.

Conceptually:

```ts
interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
```

### 6.1 Model Request

A model request SHOULD support:

```ts
interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  outputSchema?: unknown;
}
```

### 6.2 Model Response

A response MUST be capable of representing:

- assistant text/content
- zero or more requested tool calls
- structured output
- provider metadata

Provider-specific response objects MUST NOT leak into the core workflow API.

### 6.3 Provider Registration

Applications SHOULD be able to register providers.

Example:

```ts
drassos.models.register("openai", openAIProvider);
```

Model identifiers MAY use a provider-qualified form:

```text
openai:gpt-5.6
anthropic:claude-...
```

v0.3 only requires one fully functional provider implementation, but the architecture MUST support additional providers without modifying the agent runtime.

## 7. Tool Registry

Drassos MUST provide a registry for application-defined tools.

Example:

```ts
drassos.tool("getWeather", {
  description: "Get the current weather for a city.",
  input: z.object({
    city: z.string()
  }),
  handler: async ({ city }) => {
    return getWeather(city);
  }
});
```

### 7.1 Tool Definition

A tool SHOULD contain:

```ts
interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description?: string;
  input: Schema<TInput>;
  output?: Schema<TOutput>;
  handler(input: TInput, context: ToolContext): Promise<TOutput>;
}
```

### 7.2 Explicit Tool Access

An agent MUST only have access to tools explicitly granted by its agent task definition.

Example:

```ts
tools: ["searchRestaurants", "getMenu"]
```

A registered tool not present in the agent's allowed list MUST NOT be exposed to the model and MUST NOT be executable by that agent.

### 7.3 Input Validation

Tool arguments produced by a model MUST be validated against the tool's input schema before the handler executes.

Invalid arguments MUST produce a recorded tool failure or a recoverable tool-result message rather than invoking the handler with invalid data.

### 7.4 Output Validation

If a tool defines an output schema, its result MUST be validated before being persisted as a successful result.

## 8. Agent Execution Loop

The runtime MUST support multiple model/tool iterations.

Example:

```text
AgentStarted
      |
      v
ModelRequested
      |
      v
ModelResponded
      |
      +---- final result ----> AgentCompleted
      |
      +---- tool calls
              |
              v
         ToolRequested
              |
              v
          ToolStarted
              |
              v
         ToolCompleted
              |
              v
         ModelRequested
              |
             ...
```

The runtime MUST continue until one of the following occurs:

- the model produces a final result
- maximum turns are reached
- maximum tool calls are reached
- timeout expires
- execution is cancelled
- an unrecoverable error occurs

## 9. Durable Execution

Agent execution state MUST survive a Drassos process restart.

At minimum, Drassos MUST persist:

- agent execution ID
- agent task configuration needed for recovery
- current execution status
- conversation/model messages required for continuation
- model requests/responses or normalized equivalents
- tool requests
- tool inputs
- tool execution status
- tool results
- final agent result
- failure information

### 9.1 Recovery

Given:

```text
Model -> Tool A -> Tool B -> crash
```

if Tool A and Tool B completed before the crash, restarting Drassos MUST continue from the persisted state rather than automatically executing those completed tool calls again.

### 9.2 In-Flight Tool Calls

A crash may occur after an external side effect happens but before Drassos records `ToolCompleted`.

Drassos MUST explicitly model this ambiguity.

v0.3 SHOULD support an idempotency key in `ToolContext` so compatible external systems can safely deduplicate repeated attempts.

Example:

```ts
interface ToolContext {
  workflowId: string;
  agentExecutionId: string;
  toolCallId: string;
  idempotencyKey: string;
}
```

## 10. Execution History

Drassos MUST record normalized agent execution events.

At minimum:

```text
AgentStarted
ModelRequested
ModelResponded
ToolRequested
ToolStarted
ToolCompleted
ToolFailed
AgentCompleted
AgentFailed
AgentCancelled
```

Events SHOULD contain:

- event ID
- workflow ID
- agent execution ID
- timestamp
- sequence number
- relevant normalized metadata

Tool events MUST include a stable tool-call identifier.

Model events SHOULD include a stable model-call identifier.

The event model SHOULD be designed so a future UI can reconstruct the execution timeline.

## 11. Structured Agent Output

Agent tasks MUST optionally support schema-constrained output.

Example:

```ts
const recommendation = await workflow.agent(
  "restaurantResearcher",
  {
    model: "openai:gpt-5.6",
    prompt,
    tools: ["searchRestaurants", "getMenu"],
    output: z.object({
      restaurantId: z.string(),
      reasoning: z.string(),
      confidence: z.number()
    })
  }
);
```

Drassos MUST validate the final result before completing the task.

If validation fails, Drassos MAY allow the agent another turn to correct the output, subject to configured execution limits.

If no valid result is obtained, the agent task MUST fail with a structured error.

## 12. Execution Limits

Agent tasks MUST support configurable limits.

Example:

```ts
{
  maxTurns: 10,
  maxToolCalls: 20,
  timeout: "5m"
}
```

Drassos SHOULD provide sensible defaults.

The execution record MUST indicate when termination occurred because a limit was reached.

## 13. Error Handling

Drassos MUST distinguish at least:

- model provider failure
- model timeout
- invalid tool request
- unknown/unauthorized tool
- tool input validation failure
- tool execution failure
- tool output validation failure
- structured output validation failure
- agent turn limit exceeded
- agent tool-call limit exceeded
- agent timeout
- cancellation

Errors MUST be represented in normalized Drassos types rather than exposing provider-specific exception types to workflow code.

## 14. Cancellation

Cancelling a workflow MUST prevent the agent runtime from scheduling additional model or tool calls.

If possible, an in-progress provider request SHOULD be cancelled.

Already completed external side effects MUST NOT be rolled back automatically.

The agent execution MUST transition to a durable cancelled state.

## 15. Security Boundaries

The agent runtime MUST assume model output is untrusted.

Therefore:

- models MUST NOT invoke arbitrary application functions
- only registered and explicitly authorized tools may execute
- tool inputs MUST be validated
- provider credentials MUST NOT be exposed to prompts or tool arguments
- internal Drassos state MUST NOT automatically be exposed to the model
- tool execution context SHOULD expose only required metadata

## 16. Suggested Internal Components

A possible package/module structure is:

```text
src/
  agent/
    agent-runtime.ts
    agent-execution.ts
    agent-events.ts
    agent-errors.ts

  models/
    model-provider.ts
    model-registry.ts
    model-types.ts

  tools/
    tool-registry.ts
    tool-executor.ts
    tool-types.ts

  persistence/
    ...
```

The implementation SHOULD preserve separation between:

```text
Workflow Runtime
       |
       v
Agent Runtime
       |
       +------> Model Registry ------> Provider
       |
       +------> Tool Registry -------> Tool Executor
       |
       v
Persistence / Execution History
```

## 17. Testing Requirements

### 17.1 Unit Tests

Tests MUST cover:

- provider registration and lookup
- tool registration
- tool authorization
- tool input validation
- tool output validation
- model response normalization
- single-turn agent completion
- multi-turn agent execution
- multiple sequential tool calls
- execution limits
- structured output validation
- normalized error handling

### 17.2 Durable Recovery Tests

Recovery tests MUST deliberately terminate execution at important boundaries.

At minimum:

```text
AgentStarted -> crash
ModelResponded -> crash
ToolRequested -> crash
ToolStarted -> crash
ToolCompleted -> crash
ModelResponded after tool -> crash
AgentCompleted -> crash
```

Tests MUST verify that persisted completed work is reused correctly.

### 17.3 Security Tests

Tests MUST verify:

- an agent cannot call an unlisted tool
- an unknown tool cannot execute
- malformed tool arguments do not reach handlers
- invalid tool output is rejected
- arbitrary model-provided function names cannot invoke application code

## 18. Reference Demo

v0.3 MUST include an example application demonstrating an agent that researches a topic using multiple tools.

A restaurant research example is suitable:

```text
Start Workflow
      |
      v
Research Agent
      |
      +--> Search Restaurants
      |
      +--> Get Restaurant Details
      |
      +--> Get Menu
      |
      v
Structured Recommendation
      |
      v
Save Result
      |
      v
Workflow Complete
```

The demo MUST exercise at least:

- one agent task
- one model provider
- two tools
- multiple agent turns
- structured output
- durable persistence

## 19. Crash-Recovery Demo

The primary v0.3 acceptance demonstration SHOULD intentionally terminate the Drassos process during agent execution.

Expected sequence:

```text
1. Start workflow
2. Agent begins
3. Model requests Tool A
4. Tool A completes
5. Model requests Tool B
6. Tool B completes
7. Kill Drassos process
8. Restart Drassos
9. Recover workflow
10. Do NOT repeat completed Tool A or Tool B
11. Continue agent execution
12. Produce structured result
13. Complete workflow
```

This demonstration is the primary proof that Drassos' agent architecture is genuinely integrated with durable execution rather than simply wrapping an LLM SDK.

## 20. Acceptance Criteria

Drassos v0.3 is complete when:

- [ ] A workflow can invoke an agent task.
- [ ] At least one model provider works end-to-end.
- [ ] Providers are accessed through a provider-independent interface.
- [ ] Applications can register typed tools.
- [ ] Agents only see explicitly authorized tools.
- [ ] Tool inputs are schema validated.
- [ ] Tool outputs can be schema validated.
- [ ] Agents can make multiple tool calls over multiple turns.
- [ ] Agent execution state is persisted.
- [ ] Tool-call lifecycle state is persisted.
- [ ] Completed tool calls are not repeated during ordinary recovery.
- [ ] In-flight side-effect ambiguity is explicitly represented.
- [ ] Agent executions survive process restart.
- [ ] Structured output can be required and validated.
- [ ] Turn, tool-call, and timeout limits are enforced.
- [ ] Agent execution can be cancelled.
- [ ] Normalized execution history is available.
- [ ] Unit, recovery, and security tests pass.
- [ ] The reference agent demo works.
- [ ] The crash-recovery demo succeeds.

## 21. Definition of Done

v0.3 is considered done when Drassos can reliably execute a bounded AI agent inside a durable workflow, allow that agent to call authorized application tools, persist its progress, survive process failure without blindly repeating completed work, and return a validated result that deterministic workflow execution can consume.

The resulting architecture MUST provide a clean foundation for later human-in-the-loop, multi-agent, MCP, distributed execution, and observability features without requiring the core agent execution model to be redesigned.
