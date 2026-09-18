import {
  AgentLimitExceededError,
  AgentTimeoutError,
  CancellationError,
  InvalidToolRequestError,
  ModelProviderError,
  ModelTimeoutError,
  StructuredOutputError,
  ToolInputValidationError,
  ToolOutputValidationError,
  UnauthorizedToolError,
  UnknownToolError,
  serializeError,
  toError,
} from "../core/errors.ts";
import { parseDuration } from "../core/duration.ts";
import { computeBackoffMs, normalizeRetry, shouldRetry } from "../core/retry.ts";
import { toJson } from "../core/serialize.ts";
import type { Json, ObservabilityConfig } from "../core/types.ts";
import type { Store } from "../persistence/store.ts";
import type {
  AgentDefinition,
  AgentMessage,
  AgentProvider,
  AgentTool,
  ToolDefinition,
} from "../sdk/types.ts";
import { ModelBackedAgentProvider } from "../agents/providers.ts";
import type { ModelRegistry } from "../models/model-registry.ts";
import { executeAuthorizedTool, selectAuthorizedTool } from "../tools/tool-executor.ts";
import type { ToolRegistry } from "../tools/tool-registry.ts";
import { McpServerResource, type McpManager } from "./mcp.ts";

const DEFAULT_MAX_TURNS = 20;
const REDACTED = "[redacted]";

export interface ExecuteAgentOptions {
  store: Store;
  runId: string;
  stepRunId: string;
  agent: AgentDefinition;
  input: unknown;
  defaultProvider?: AgentProvider;
  abortSignal: AbortSignal;
  mcp?: McpManager;
  models?: ModelRegistry;
  toolRegistry?: ToolRegistry;
  onCheckpoint?: (name: string) => Promise<void> | void;
}

export async function executeAgent(options: ExecuteAgentOptions): Promise<unknown> {
  const provider = resolveProvider(options);
  const tools = await resolveAgentTools(options);
  const observability: ObservabilityConfig = {
    recordPrompts: options.agent.observability?.recordPrompts ?? true,
    recordResponses: options.agent.observability?.recordResponses ?? true,
    recordToolArguments: options.agent.observability?.recordToolArguments ?? true,
    recordToolResults: options.agent.observability?.recordToolResults ?? true,
  };
  const limits = options.agent.limits ?? {};
  const maxTurns = limits.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxToolCalls = limits.maxToolCalls ?? 50;
  const timeoutMs = limits.timeout !== undefined ? parseDuration(limits.timeout) : null;
  const modelRetry = normalizeRetry(options.agent.retry ?? { maxAttempts: 3, backoff: "exponential" });

  let agentRun = await options.store.getAgentRunByStep(options.stepRunId);
  if (!agentRun) {
    agentRun = await options.store.insertAgentRun({
      runId: options.runId,
      stepRunId: options.stepRunId,
      agentName: options.agent.name,
      status: "RUNNING",
      limits,
    });
    await options.store.appendHistory({
      runId: options.runId,
      type: "agent.run.started",
      payload: { agentRunId: agentRun.id, agent: options.agent.name },
    });
    await options.onCheckpoint?.("agent-started");
  }
  if (agentRun.status === "COMPLETED") {
    return agentRun.output;
  }
  if (agentRun.status === "CANCELLED") {
    throw new CancellationError();
  }
  if (agentRun.status === "TIMED_OUT") {
    throw new AgentTimeoutError();
  }
  if (agentRun.status === "FAILED") {
    const error = new Error(agentRun.error?.message ?? "Agent failed");
    error.name = agentRun.error?.name ?? "Error";
    throw error;
  }

  const existingTurns = await options.store.listAgentTurns(agentRun.id);
  let messages: AgentMessage[] = reconstructMessages(existingTurns);
  const startedAt = new Date(agentRun.startedAt).getTime();
  const agentRunId = agentRun.id;
  const throwIfTimedOut = async () => {
    if (timeoutMs !== null && Date.now() - startedAt > timeoutMs) {
      await failAgent(options.store, agentRunId, options.runId, "TIMED_OUT", new AgentTimeoutError());
      throw new AgentTimeoutError(`Agent "${options.agent.name}" exceeded timeout`);
    }
  };

  const toolSchemas = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? zodToJsonSchema(tool.input)) as Json,
  }));

  while (true) {
    await throwIfCancelled(options, agentRun.id);
    await throwIfTimedOut();
    if (agentRun.toolCallCount >= maxToolCalls) {
      const error = new AgentLimitExceededError("maxToolCalls", `Agent exceeded maxToolCalls (${maxToolCalls})`);
      await failAgent(options.store, agentRun.id, options.runId, "FAILED", error);
      throw error;
    }

    const turns = await options.store.listAgentTurns(agentRun.id);
    const lastTurn = turns.at(-1);
    const turnNumber = lastTurn && !lastTurn.completedAt ? lastTurn.turnNumber : (lastTurn?.turnNumber ?? 0) + 1;
    if (turnNumber > maxTurns) {
      const error = new AgentLimitExceededError("maxTurns", `Agent "${options.agent.name}" exceeded maxTurns (${maxTurns})`);
      await failAgent(options.store, agentRun.id, options.runId, "FAILED", error);
      throw error;
    }

    let turn = turns.find((item) => item.turnNumber === turnNumber);
    if (!turn) {
      turn = await options.store.insertAgentTurn({
        agentRunId: agentRun.id,
        runId: options.runId,
        turnNumber,
        inputMessages: maybeRedact(messages, observability.recordPrompts),
      });
      await options.store.appendHistory({
        runId: options.runId,
        type: "agent.turn.started",
        payload: { agentRunId: agentRun.id, turnId: turn.id, turn: turnNumber },
      });
      await options.store.updateAgentRun(agentRun.id, { currentTurn: turnNumber, status: "RUNNING" });
      await options.onCheckpoint?.("turn-started");
    }

    const existingModels = await options.store.listModelCalls(agentRun.id);
    let modelCall = existingModels.filter((call) => call.agentTurnId === turn.id).at(-1);
    let toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
    let output: unknown = null;
    let tokenInput: number | null = null;
    let tokenOutput: number | null = null;
    let resultModel: string | undefined;

    if (modelCall?.completedAt && !modelCall.error) {
      const persisted = asAgentResult(modelCall.response);
      const requested = Array.isArray(turn.requestedTools) ? turn.requestedTools : persisted.toolCalls;
      toolCalls = (requested ?? []) as Array<{ id: string; name: string; arguments: unknown }>;
      output = persisted.output ?? persisted;
      tokenInput = modelCall.tokenInput;
      tokenOutput = modelCall.tokenOutput;
      resultModel = modelCall.model ?? options.agent.model ?? undefined;
      if (persisted.messages?.length) {
        messages = persisted.messages;
      }
    } else {
      if (!modelCall) {
        modelCall = await options.store.insertModelCall({
          agentRunId: agentRun.id,
          agentTurnId: turn.id,
          runId: options.runId,
          provider: provider.name,
          model: options.agent.model,
          request: maybeRedact({ input: options.input, messages }, observability.recordPrompts),
        });
        await options.store.appendHistory({
          runId: options.runId,
          type: "model.started",
          payload: { modelCallId: modelCall.id, provider: provider.name, model: options.agent.model ?? null },
        });
      }
      await options.onCheckpoint?.("before-model");
      const started = Date.now();
      let attempt = modelCall.attempt ?? 0;
      let result;
      while (true) {
        attempt += 1;
        try {
          const remaining = timeoutMs === null ? null : timeoutMs - (Date.now() - startedAt);
          if (remaining !== null && remaining <= 0) {
            await throwIfTimedOut();
          }
          result = await provider.execute({
            instructions: options.agent.instructions,
            input: options.input,
            messages,
            tools: toolSchemas,
            model: options.agent.model,
            outputSchema: options.agent.output,
            abortSignal: combineAbortSignals(options.abortSignal, remaining),
          });
          break;
        } catch (error) {
          await throwIfCancelled(options, agentRun.id);
          if (timeoutMs !== null && Date.now() - startedAt > timeoutMs) {
            await failAgent(options.store, agentRun.id, options.runId, "TIMED_OUT", new AgentTimeoutError());
            throw new AgentTimeoutError(`Agent "${options.agent.name}" exceeded timeout`);
          }
          const wrapped = isAbortError(error)
            ? new ModelTimeoutError(toError(error).message)
            : new ModelProviderError(toError(error).message, error);
          if (!shouldRetry(modelRetry, attempt) || wrapped instanceof ModelTimeoutError) {
            await options.store.completeModelCall(modelCall.id, {
              error: serializeError(wrapped, { attempt }),
            });
            await options.store.appendHistory({
              runId: options.runId,
              type: "model.failed",
              payload: { modelCallId: modelCall.id, error: serializeError(wrapped) },
            });
            await failAgent(options.store, agentRun.id, options.runId, "FAILED", wrapped);
            throw wrapped;
          }
          await sleep(computeBackoffMs(modelRetry, attempt));
        }
      }
      await options.store.completeModelCall(modelCall.id, {
        response: maybeRedact(result, observability.recordResponses),
        tokenInput: result.tokenInput ?? null,
        tokenOutput: result.tokenOutput ?? null,
        latencyMs: Date.now() - started,
        stopReason: result.finishReason ?? (result.toolCalls?.length ? "tool_calls" : "stop"),
      });
      await options.store.updateAgentRun(agentRun.id, { modelCallCount: agentRun.modelCallCount + 1 });
      agentRun = (await options.store.getAgentRun(agentRun.id)) ?? agentRun;
      await options.store.appendHistory({
        runId: options.runId,
        type: "model.completed",
        payload: {
          modelCallId: modelCall.id,
          latencyMs: Date.now() - started,
          tokenInput: result.tokenInput ?? null,
          tokenOutput: result.tokenOutput ?? null,
        },
      });
      const assistant: AgentMessage = {
        role: "assistant",
        content: typeof result.output === "string" ? result.output : result.output ? JSON.stringify(result.output) : undefined,
        toolCalls: result.toolCalls,
      };
      messages = result.messages ?? [...messages, assistant];
      await options.store.updateAgentTurn(turn.id, {
        outputMessages: maybeRedact(messages, observability.recordResponses),
        requestedTools: result.toolCalls ? toJson(result.toolCalls) : null,
      });
      await options.onCheckpoint?.("after-model");
      toolCalls = result.toolCalls ?? [];
      output = result.output;
      tokenInput = result.tokenInput ?? null;
      tokenOutput = result.tokenOutput ?? null;
      resultModel = result.model ?? options.agent.model ?? undefined;
      await throwIfTimedOut();
    }

    if (!toolCalls.length) {
      await throwIfTimedOut();
      if (options.agent.output) {
        const parsed = options.agent.output.safeParse(output);
        if (!parsed.success) {
          if (turnNumber >= maxTurns) {
            const error = new StructuredOutputError(parsed.error.message);
            await failAgent(options.store, agentRun.id, options.runId, "FAILED", error);
            throw error;
          }
          messages.push({
            role: "user",
            content: `Output failed schema validation: ${parsed.error.message}. Return valid JSON matching the required schema.`,
          });
          await options.store.updateAgentTurn(turn.id, {
            completedAt: new Date().toISOString(),
            outputMessages: maybeRedact(messages, observability.recordResponses),
          });
          await options.store.appendHistory({
            runId: options.runId,
            type: "agent.turn.completed",
            payload: { turnId: turn.id, turn: turnNumber, outputValid: false },
          });
          await options.onCheckpoint?.("between-turns");
          continue;
        }
        output = parsed.data;
      }
      await options.onCheckpoint?.("before-complete");
      const json = toJson(output);
      await options.store.updateAgentTurn(turn.id, {
        completedAt: new Date().toISOString(),
        outputMessages: maybeRedact(messages, observability.recordResponses),
      });
      await options.store.appendHistory({
        runId: options.runId,
        type: "agent.turn.completed",
        payload: { turnId: turn.id, turn: turnNumber },
      });
      await options.store.updateAgentRun(agentRun.id, {
        status: "COMPLETED",
        output: json,
        completedAt: new Date().toISOString(),
      });
      await options.store.insertAgentExecution({
        stepRunId: options.stepRunId,
        runId: options.runId,
        provider: provider.name,
        model: resultModel ?? options.agent.model ?? null,
        messages: maybeRedact(messages, observability.recordResponses),
        tokenInput,
        tokenOutput,
      });
      await options.store.appendHistory({
        runId: options.runId,
        type: "agent.run.completed",
        payload: { agentRunId: agentRun.id },
      });
      await options.onCheckpoint?.("agent-completed");
      return output;
    }

    await throwIfTimedOut();
    await options.store.updateAgentRun(agentRun.id, { status: "WAITING_FOR_TOOL" });
    for (const call of toolCalls) {
      await throwIfCancelled(options, agentRun.id);
      agentRun = (await options.store.getAgentRun(agentRun.id)) ?? agentRun;
      const listed = await options.store.listToolCalls({ agentRunId: agentRun.id });
      const existing = listed.find(
        (item) =>
          item.agentTurnId === turn.id &&
          (item.idempotencyKey === String(call.id) || item.name === call.name),
      );
      const alreadyFinished = existing?.status === "COMPLETED" || existing?.status === "FAILED";
      if (!alreadyFinished && agentRun.toolCallCount >= maxToolCalls) {
        const error = new AgentLimitExceededError("maxToolCalls", `Agent exceeded maxToolCalls (${maxToolCalls})`);
        await failAgent(options.store, agentRun.id, options.runId, "FAILED", error);
        throw error;
      }
      await executeDurableTool({
        options,
        agentRunId: agentRun.id,
        turnId: turn.id,
        tools,
        call: { id: String(call.id), name: call.name, arguments: call.arguments },
        observability,
        messages,
      });
      agentRun = (await options.store.getAgentRun(agentRun.id)) ?? agentRun;
    }
    await options.store.updateAgentTurn(turn.id, {
      completedAt: new Date().toISOString(),
      outputMessages: maybeRedact(messages, observability.recordResponses),
    });
    await options.store.appendHistory({
      runId: options.runId,
      type: "agent.turn.completed",
      payload: { turnId: turn.id, turn: turnNumber },
    });
    await options.onCheckpoint?.("between-turns");
  }
}

async function executeDurableTool(args: {
  options: ExecuteAgentOptions;
  agentRunId: string;
  turnId: string;
  tools: ToolDefinition[];
  call: { id: string; name: string; arguments: unknown };
  observability: ObservabilityConfig;
  messages: AgentMessage[];
}): Promise<void> {
  const listed = await args.options.store.listToolCalls({ agentRunId: args.agentRunId });
  const existing = listed.find((item) => {
    if (item.agentTurnId !== args.turnId) {
      return false;
    }
    if (args.call.id && item.idempotencyKey === args.call.id) {
      return true;
    }
    return !item.idempotencyKey && item.name === args.call.name;
  }) ?? listed.find(
    (item) => item.agentTurnId === args.turnId && item.name === args.call.name && !args.call.id,
  );
  if (existing?.status === "COMPLETED" || existing?.status === "FAILED") {
    args.messages.push({
      role: "tool",
      toolCallId: args.call.id,
      content: JSON.stringify(existing.status === "FAILED" ? { error: existing.error?.message } : existing.result),
    });
    return;
  }
  let authorized: ToolDefinition | undefined;
  let authError: Error | undefined;
  if (!args.call.name) {
    authError = new InvalidToolRequestError("Model requested a tool call without a name");
    args.call.name = "invalid_tool_request";
  } else {
    try {
      authorized = selectAuthorizedTool(args.call.name, args.tools);
    } catch (error) {
      authError = toError(error);
    }
  }
  const record =
    existing ??
    (await args.options.store.insertToolCall({
      agentRunId: args.agentRunId,
      agentTurnId: args.turnId,
      runId: args.options.runId,
      name: args.call.name,
      source: authorized?.source ?? "local",
      server: authorized?.server ?? null,
      arguments: maybeRedact(args.call.arguments, args.observability.recordToolArguments),
      idempotencyKey: args.call.id,
    }));
  if (!existing) {
    await args.options.store.appendHistory({
      runId: args.options.runId,
      type: "tool.requested",
      payload: { name: args.call.name, toolCallId: record.id },
    });
    await args.options.onCheckpoint?.("tool-requested");
  }
  const invocation = await args.options.store.insertToolInvocation({
    stepRunId: args.options.stepRunId,
    runId: args.options.runId,
    name: args.call.name,
    input: args.observability.recordToolArguments === false ? REDACTED : args.call.arguments,
  });
  await args.options.store.updateToolCall(record.id, { status: "RUNNING" });
  await args.options.store.appendHistory({
    runId: args.options.runId,
    type: "tool.started",
    payload: { name: args.call.name, toolCallId: record.id, source: authorized?.source ?? "local", server: authorized?.server ?? null },
  });
  await args.options.onCheckpoint?.("before-tool");
  await args.options.onCheckpoint?.("tool-started");
  if (authError) {
    const persisted = serializeError(authError, { attempt: 1 });
    await args.options.store.completeToolCall(record.id, { status: "FAILED", error: persisted, attempt: 1 });
    await args.options.store.completeToolInvocation(invocation.id, null, persisted);
    await args.options.store.appendHistory({
      runId: args.options.runId,
      type: "tool.failed",
      payload: { name: args.call.name, toolCallId: record.id, error: persisted },
    });
    args.messages.push({
      role: "tool",
      toolCallId: args.call.id,
      content: JSON.stringify({ error: authError.message }),
    });
    return;
  }
  const tool = authorized!;
  const retry = normalizeRetry(tool.retry ?? { maxAttempts: 2, backoff: "fixed", initialIntervalMs: 50 });
  let attempt = 0;
  let output: unknown;
  while (true) {
    attempt += 1;
    try {
      output = await executeAuthorizedTool(tool, args.call.arguments, {
        runId: args.options.runId,
        workflowId: args.options.runId,
        agentExecutionId: args.agentRunId,
        toolCallId: record.id,
        idempotencyKey: args.call.id,
        abortSignal: args.options.abortSignal,
      });
      break;
    } catch (error) {
      const persisted = serializeError(error, { attempt });
      const nonRetryable =
        error instanceof ToolInputValidationError ||
        error instanceof ToolOutputValidationError ||
        error instanceof UnauthorizedToolError ||
        error instanceof UnknownToolError ||
        error instanceof CancellationError;
      if (nonRetryable || !shouldRetry(retry, attempt)) {
        await args.options.store.completeToolCall(record.id, { status: "FAILED", error: persisted, attempt });
        await args.options.store.completeToolInvocation(invocation.id, null, persisted);
        await args.options.store.appendHistory({
          runId: args.options.runId,
          type: "tool.failed",
          payload: { name: args.call.name, toolCallId: record.id, error: persisted },
        });
        args.messages.push({
          role: "tool",
          toolCallId: args.call.id,
          content: JSON.stringify({ error: toError(error).message }),
        });
        return;
      }
      await sleep(computeBackoffMs(retry, attempt));
    }
  }
  await args.options.store.completeToolCall(record.id, {
    status: "COMPLETED",
    result: maybeRedact(output, args.observability.recordToolResults),
    attempt,
  });
  await args.options.store.completeToolInvocation(invocation.id, args.observability.recordToolResults === false ? REDACTED : output);
  const agentRun = await args.options.store.getAgentRun(args.agentRunId);
  await args.options.store.updateAgentRun(args.agentRunId, {
    toolCallCount: (agentRun?.toolCallCount ?? 0) + 1,
    status: "RUNNING",
  });
  await args.options.store.appendHistory({
    runId: args.options.runId,
    type: "tool.completed",
    payload: { name: args.call.name, toolCallId: record.id },
  });
  args.messages.push({
    role: "tool",
    toolCallId: args.call.id,
    content: JSON.stringify(output),
  });
  await args.options.onCheckpoint?.("after-tool");
}

async function resolveAgentTools(options: ExecuteAgentOptions): Promise<ToolDefinition[]> {
  if (options.agent.allowedToolNames?.length) {
    if (!options.toolRegistry) {
      throw new UnknownToolError(options.agent.allowedToolNames[0]!);
    }
    return options.toolRegistry.authorize(options.agent.allowedToolNames);
  }
  return resolveTools(options.agent.tools ?? [], options.mcp);
}

function resolveProvider(options: ExecuteAgentOptions): AgentProvider {
  if (options.agent.provider) {
    return options.agent.provider;
  }
  if (options.agent.model && options.models) {
    try {
      return new ModelBackedAgentProvider(options.models.resolve(options.agent.model), options.abortSignal);
    } catch {
      // fall through to default
    }
  }
  if (options.defaultProvider) {
    return options.defaultProvider;
  }
  throw new Error(`Agent "${options.agent.name}" has no provider configured`);
}

async function resolveTools(tools: AgentTool[], mcp?: McpManager): Promise<ToolDefinition[]> {
  const resolved: ToolDefinition[] = [];
  for (const item of tools) {
    if (item instanceof McpServerResource || (item as { kind?: string }).kind === "mcp-resource") {
      if (!mcp) {
        throw new Error(`MCP manager is required to use server ${(item as McpServerResource).name}`);
      }
      resolved.push(...(await mcp.toolsFor(item as McpServerResource)));
      continue;
    }
    resolved.push(item as ToolDefinition);
  }
  return resolved;
}

function reconstructMessages(turns: Array<{ inputMessages: unknown; outputMessages: unknown }>): AgentMessage[] {
  const last = turns.filter((turn) => turn.outputMessages).at(-1);
  if (last?.outputMessages && Array.isArray(last.outputMessages)) {
    return last.outputMessages as AgentMessage[];
  }
  return [];
}

function maybeRedact(value: unknown, record: boolean | undefined): ReturnType<typeof toJson> {
  if (record === false) {
    return REDACTED;
  }
  return toJson(value);
}

function asAgentResult(value: unknown): {
  output?: unknown;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  messages?: AgentMessage[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { output: value };
  }
  return value as {
    output?: unknown;
    toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
    messages?: AgentMessage[];
  };
}

async function failAgent(
  store: Store,
  agentRunId: string,
  runId: string,
  status: "FAILED" | "TIMED_OUT" | "CANCELLED",
  error: Error,
): Promise<void> {
  const current = await store.getAgentRun(agentRunId);
  if (
    current &&
    (current.status === "COMPLETED" ||
      current.status === "FAILED" ||
      current.status === "CANCELLED" ||
      current.status === "TIMED_OUT")
  ) {
    return;
  }
  await store.updateAgentRun(agentRunId, {
    status,
    error: serializeError(error),
    completedAt: new Date().toISOString(),
  });
  await store.appendHistory({
    runId,
    type: status === "CANCELLED" ? "agent.run.cancelled" : "agent.run.failed",
    payload: { agentRunId, error: serializeError(error), status },
  });
}

async function throwIfCancelled(options: ExecuteAgentOptions, agentRunId?: string): Promise<void> {
  const run = await options.store.getRun(options.runId);
  if (options.abortSignal.aborted || run?.status === "CANCELLED") {
    if (agentRunId) {
      await failAgent(options.store, agentRunId, options.runId, "CANCELLED", new CancellationError());
    }
    throw new CancellationError();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineAbortSignals(signal: AbortSignal, timeoutMs: number | null): AbortSignal {
  if (timeoutMs === null) {
    return signal;
  }
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeout]);
  }
  return signal;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError" || name === "ModelTimeoutError";
}

function zodToJsonSchema(schema?: unknown): Json {
  if (
    schema &&
    typeof schema === "object" &&
    "toJSONSchema" in schema &&
    typeof (schema as { toJSONSchema?: unknown }).toJSONSchema === "function"
  ) {
    return toJson((schema as { toJSONSchema: () => unknown }).toJSONSchema());
  }
  return { type: "object", additionalProperties: true };
}
