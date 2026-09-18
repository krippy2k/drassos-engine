import type { z } from "zod";
import type { AgentDefinition, AgentTool, ToolDefinition } from "./types.ts";
import type { AgentLimits, ObservabilityConfig, RetryPolicy } from "../core/types.ts";
import type { AgentProvider } from "./types.ts";

export function tool<TSchema extends z.ZodTypeAny>(definition: {
  name: string;
  description: string;
  input: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<unknown> | unknown;
  retry?: RetryPolicy;
}): ToolDefinition {
  return { ...definition, source: "local" };
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
