import type {
  Json,
  AgentLimits,
  ObservabilityConfig,
  RetryPolicy,
  StepOptions,
  ApprovalOptions,
  HumanDecision,
  SignalOptions,
  SignalWaitResult,
  ChildExecutionOptions,
  DelegationPlan,
  ExecutionHandle,
} from "../core/types.ts";
import type { z } from "zod";
import type { Capability } from "../capabilities/types.ts";

export interface ToolContext {
  runId: string;
  workflowId: string;
  agentExecutionId: string;
  toolCallId: string;
  idempotencyKey: string;
  abortSignal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input?: z.ZodTypeAny;
  output?: z.ZodTypeAny;
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

export type AgentTool = ToolDefinition | McpResourceLike | McpToolLike;

export interface McpToolLike {
  readonly kind: "mcp-tool";
  readonly name: string;
}

export interface RemoteAgentHandle {
  readonly kind: "a2a";
  readonly name: string;
}

export interface AgentDefinition {
  name: string;
  instructions: string;
  tools?: AgentTool[];
  allowedToolNames?: string[];
  provider?: AgentProvider;
  model?: string;
  limits?: AgentLimits;
  observability?: ObservabilityConfig;
  retry?: RetryPolicy;
  output?: z.ZodTypeAny;
  delegateTo?: string[] | "*";
}

export interface AgentTaskOptions<TOutput = unknown> {
  model: string;
  prompt: string;
  tools?: string[];
  output?: z.ZodTypeAny;
  maxTurns?: number;
  maxToolCalls?: number;
  timeout?: string | number;
  input?: unknown;
  _outputType?: TOutput;
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
  outputSchema?: unknown;
  abortSignal?: AbortSignal;
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

  activity<T = unknown>(name: string, input?: unknown, options?: StepOptions): Promise<T>;

  agent: {
    (target: AgentDefinition | RemoteAgentHandle): {
      run<T = unknown>(input?: unknown): Promise<T>;
    };
    <T = unknown>(
      name: string,
      options: {
        agent: AgentDefinition;
        input?: unknown;
        prompt?: string;
        retry?: StepOptions["retry"];
        timeout?: StepOptions["timeout"];
      } & ChildExecutionOptions,
    ): Promise<T>;
    <T = unknown>(name: string, options: AgentTaskOptions<T> & ChildExecutionOptions): Promise<T>;
    <T = unknown>(name: string, input?: unknown, options?: ChildExecutionOptions): Promise<T>;
    run<T = unknown>(
      agent: AgentDefinition,
      options?: { prompt?: string; input?: unknown; name?: string } & ChildExecutionOptions,
    ): Promise<T>;
  };

  tool(target: ToolDefinition | McpToolLike | Capability): { run<T = unknown>(input?: unknown): Promise<T> };

  human: {
    <T = unknown>(name: string, options?: HumanOptions): Promise<T>;
    approve<T = unknown>(options?: HumanOptions): Promise<T>;
  };

  workflow: {
    <T = unknown>(name: string, input?: unknown, options?: ChildExecutionOptions): Promise<T>;
    run<T = unknown>(
      definition: WorkflowDefinition,
      input?: unknown,
      options?: { name?: string; cancelChildren?: boolean } & ChildExecutionOptions,
    ): Promise<T>;
  };

  startWorkflow<T = unknown>(
    name: string,
    input?: unknown,
    options?: ChildExecutionOptions,
  ): Promise<ExecutionHandle<T>>;

  map<T, R>(
    items: T[],
    callback: (item: T, index: number) => Promise<R>,
    options?: { concurrency?: number; name?: string },
  ): Promise<R[]>;

  executePlan(
    plan: DelegationPlan,
    options?: { concurrency?: number } & ChildExecutionOptions,
  ): Promise<Record<string, unknown>>;

  sleep(duration: string | number): Promise<void>;
  sleep(name: string, duration: string | number): Promise<void>;

  now(): Date;
  random(): number;
  uuid(): string;

  waitForEvent<T = unknown>(type: string): Promise<T>;
  waitForSignal<T = unknown>(name: string): Promise<T>;
  waitForSignal<T = unknown>(name: string, options: SignalOptions & { timeout: string | number }): Promise<SignalWaitResult<T>>;
  waitForSignal<T = unknown>(name: string, options?: SignalOptions): Promise<T | SignalWaitResult<T>>;

  approval<T = unknown>(options: ApprovalOptions): Promise<HumanDecision<T>>;

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
  agents?: AgentDefinition[];
  tools?: ToolDefinition[];
  models?: Record<string, import("../models/model-types.ts").ModelProvider>;
  defaultAgentProvider?: AgentProvider;
}

export type {
  ApprovalOptions,
  HumanDecision,
  HumanInteraction,
  HumanInteractionStatus,
  SignalOptions,
  SignalWaitResult,
  WorkflowSignal,
  ChildExecutionOptions,
  DelegationPlan,
  DelegationTask,
  Execution,
  ExecutionHandle,
  ExecutionMetadata,
  ExecutionNode,
  OrchestrationLimits,
} from "../core/types.ts";
