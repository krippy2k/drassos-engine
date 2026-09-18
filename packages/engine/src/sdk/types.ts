import type { Json, AgentLimits, ObservabilityConfig, RetryPolicy, StepOptions } from "../core/types.ts";
import type { z } from "zod";

export interface ToolContext {
  runId: string;
  agentRunId?: string;
  toolCallId?: string;
  abortSignal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input?: z.ZodTypeAny;
  inputSchema?: Json;
  source?: "local" | "mcp";
  server?: string;
  retry?: RetryPolicy;
  execute: (input: any, context?: ToolContext) => Promise<unknown> | unknown;
}

export interface McpResourceLike {
  readonly kind: "mcp-resource";
  readonly name: string;
}

export type AgentTool = ToolDefinition | McpResourceLike;

export interface AgentDefinition {
  name: string;
  instructions: string;
  tools?: AgentTool[];
  provider?: AgentProvider;
  model?: string;
  limits?: AgentLimits;
  observability?: ObservabilityConfig;
  retry?: RetryPolicy;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Json;
}

export interface AgentRequest {
  instructions: string;
  input: unknown;
  messages: AgentMessage[];
  tools: Array<{ name: string; description: string; inputSchema: Json }>;
  model?: string;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCallId?: string;
  toolCalls?: AgentToolCall[];
}

export interface AgentResult {
  output: unknown;
  messages?: AgentMessage[];
  toolCalls?: AgentToolCall[];
  model?: string;
  tokenInput?: number;
  tokenOutput?: number;
  finishReason?: string;
}

export interface AgentProvider {
  readonly name: string;
  execute(request: AgentRequest): Promise<AgentResult>;
}

export interface WorkflowContext<TInput = unknown> {
  readonly input: TInput;
  readonly runId: string;
  readonly workflowName: string;
  readonly abortSignal: AbortSignal;

  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  step<T>(name: string, options: StepOptions, fn: () => Promise<T> | T): Promise<T>;

  agent: {
    <T = unknown>(
      name: string,
      options: {
        agent: AgentDefinition;
        input?: unknown;
        prompt?: string;
        retry?: StepOptions["retry"];
        timeout?: StepOptions["timeout"];
      },
    ): Promise<T>;
    run<T = unknown>(
      agent: AgentDefinition,
      options?: { prompt?: string; input?: unknown; name?: string },
    ): Promise<T>;
  };

  human: {
    <T = unknown>(name: string, options?: HumanOptions): Promise<T>;
    approve<T = unknown>(options?: HumanOptions): Promise<T>;
  };

  workflow: {
    run<T = unknown>(
      definition: WorkflowDefinition,
      input?: unknown,
      options?: { name?: string; cancelChildren?: boolean },
    ): Promise<T>;
  };

  sleep(duration: string | number): Promise<void>;
  sleep(name: string, duration: string | number): Promise<void>;

  waitForEvent<T = unknown>(type: string): Promise<T>;

  parallel<const T extends ReadonlyArray<() => Promise<unknown>>>(
    fns: T,
  ): Promise<{ [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never }>;
}

export interface HumanOptions {
  title?: string;
  assignedTo?: string;
  data?: unknown;
}

export interface WorkflowDefinition<TInput = any, TOutput = unknown> {
  name: string;
  version: string;
  fn: (ctx: WorkflowContext<TInput>) => Promise<TOutput>;
}

export interface DrassosApp {
  workflows: WorkflowDefinition[];
  defaultAgentProvider?: AgentProvider;
}
