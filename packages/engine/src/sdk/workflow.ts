import type { WorkflowContext, WorkflowDefinition } from "./types.ts";

export function workflow<TInput = unknown, TOutput = unknown>(
  name: string,
  fn: (ctx: WorkflowContext<TInput>) => Promise<TOutput>,
  options?: { version?: string },
): WorkflowDefinition<TInput, TOutput> {
  return {
    name,
    version: options?.version ?? "1",
    fn,
  };
}
