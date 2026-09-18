import type { WorkflowContext, WorkflowDefinition } from "./types.ts";
import { isValidWorkflowVersion } from "../core/version.ts";
import { WorkflowRegistrationError } from "../core/errors.ts";

export interface WorkflowOptions<TInput = unknown, TOutput = unknown> {
  version: string;
  run: (ctx: WorkflowContext<TInput>) => Promise<TOutput>;
}

export function workflow<TInput = unknown, TOutput = unknown>(
  name: string,
  options: WorkflowOptions<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput>;
export function workflow<TInput = unknown, TOutput = unknown>(
  name: string,
  fn: (ctx: WorkflowContext<TInput>) => Promise<TOutput>,
  options?: { version?: string },
): WorkflowDefinition<TInput, TOutput>;
export function workflow<TInput = unknown, TOutput = unknown>(
  name: string,
  fnOrOptions: ((ctx: WorkflowContext<TInput>) => Promise<TOutput>) | WorkflowOptions<TInput, TOutput>,
  options?: { version?: string },
): WorkflowDefinition<TInput, TOutput> {
  const fn = typeof fnOrOptions === "function" ? fnOrOptions : fnOrOptions.run;
  const version = typeof fnOrOptions === "function" ? (options?.version ?? "1") : fnOrOptions.version;
  if (!isValidWorkflowVersion(version)) {
    throw new WorkflowRegistrationError(`Invalid workflow version "${version}" for "${name}"`);
  }
  return { name, version, fn };
}
