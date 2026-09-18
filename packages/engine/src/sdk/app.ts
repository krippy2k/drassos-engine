import type { AgentDefinition, AgentProvider, DrassosApp, WorkflowDefinition } from "./types.ts";

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}

export function defineApp(app: {
  workflows: WorkflowDefinition[];
  tools?: import("./types.ts").ToolDefinition[];
  models?: Record<string, import("../models/model-types.ts").ModelProvider>;
  defaultAgentProvider?: AgentProvider;
}): DrassosApp {
  return app;
}

export function defineWorkflow<TInput = unknown, TOutput = unknown>(
  fn: WorkflowDefinition<TInput, TOutput>["fn"],
  options?: { name?: string; version?: string },
): WorkflowDefinition<TInput, TOutput> {
  return {
    name: options?.name ?? fn.name ?? "workflow",
    version: options?.version ?? "1",
    fn,
  };
}
