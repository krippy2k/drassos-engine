import type { z } from "zod";
import type { AgentDefinition, AgentTool, ToolContext, ToolDefinition } from "./types.ts";
import type { AgentLimits, ObservabilityConfig, RetryPolicy } from "../core/types.ts";
import type { AgentProvider } from "./types.ts";

export function tool<TSchema extends z.ZodTypeAny, TOutput = unknown>(definition: {
  name: string;
  description: string;
  input: TSchema;
  output?: z.ZodTypeAny;
  execute?: (input: z.infer<TSchema>, context?: ToolContext) => Promise<TOutput> | TOutput;
  handler?: (input: z.infer<TSchema>, context?: ToolContext) => Promise<TOutput> | TOutput;
  retry?: RetryPolicy;
}): ToolDefinition {
  const execute = definition.execute ?? definition.handler;
  if (!execute) {
    throw new Error(`Tool "${definition.name}" requires execute or handler`);
  }
  return { ...definition, execute, source: "local" };
}

export function agent(definition: {
  name?: string;
  model?: string;
  system?: string;
  instructions?: string;
  tools?: AgentTool[];
  limits?: AgentLimits;
  observability?: ObservabilityConfig;
  retry?: RetryPolicy;
  provider?: AgentProvider;
}): AgentDefinition {
  return {
    name: definition.name ?? definition.model ?? "agent",
    instructions: definition.system ?? definition.instructions ?? "",
    model: definition.model,
    tools: definition.tools,
    limits: definition.limits,
    observability: definition.observability,
    retry: definition.retry,
    provider: definition.provider,
  };
}
