import type { AgentDefinition, AgentProvider, DrassosApp, ToolDefinition, WorkflowDefinition } from "./sdk-types.ts";
import type { ModelProvider } from "./model-types.ts";

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}

export function defineApp(app: {
  workflows: WorkflowDefinition[];
  agents?: AgentDefinition[];
  tools?: ToolDefinition[];
  models?: Record<string, ModelProvider>;
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
