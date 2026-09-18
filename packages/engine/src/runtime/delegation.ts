import {
  CircularDependencyError,
  InvalidDelegationPlanError,
  UnknownAgentError,
  UnknownWorkflowError,
} from "../core/errors.ts";
import { assertSerializable } from "../core/serialize.ts";
import type { DelegationPlan, DelegationTask, OrchestrationLimits } from "../core/types.ts";
import { DEFAULT_ORCHESTRATION_LIMITS } from "../core/types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { WorkflowRegistry } from "./registry.ts";

export interface DelegationValidationContext {
  workflows?: WorkflowRegistry;
  agents?: AgentRegistry;
  limits?: OrchestrationLimits;
  currentDepth?: number;
  authorize?: (type: DelegationTask["type"], target: string) => boolean;
}

export function validateDelegationPlan(
  plan: DelegationPlan,
  context: DelegationValidationContext = {},
): DelegationTask[] {
  if (!plan || !Array.isArray(plan.tasks)) {
    throw new InvalidDelegationPlanError("Delegation plan must include a tasks array");
  }
  const limits = { ...DEFAULT_ORCHESTRATION_LIMITS, ...context.limits };
  if (plan.tasks.length > limits.maxChildrenPerExecution) {
    throw new InvalidDelegationPlanError(
      `Delegation plan has ${plan.tasks.length} tasks; maxChildrenPerExecution is ${limits.maxChildrenPerExecution}`,
    );
  }
  const depth = (context.currentDepth ?? 0) + 1;
  if (depth > limits.maxDepth) {
    throw new InvalidDelegationPlanError(
      `Delegation plan would exceed max execution depth ${limits.maxDepth}`,
    );
  }

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    validateTask(task, context, ids);
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new InvalidDelegationPlanError(`Task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
  }

  assertAcyclic(plan.tasks);
  return plan.tasks;
}

function validateTask(
  task: DelegationTask,
  context: DelegationValidationContext,
  ids: Set<string>,
): void {
  if (!task || typeof task !== "object") {
    throw new InvalidDelegationPlanError("Each delegation task must be an object");
  }
  if (!task.id || typeof task.id !== "string") {
    throw new InvalidDelegationPlanError("Each delegation task requires a string id");
  }
  if (ids.has(task.id)) {
    throw new InvalidDelegationPlanError(`Duplicate task id "${task.id}"`);
  }
  ids.add(task.id);
  if (task.type !== "agent" && task.type !== "workflow") {
    throw new InvalidDelegationPlanError(`Task "${task.id}" has invalid type "${String(task.type)}"`);
  }
  if (!task.target || typeof task.target !== "string") {
    throw new InvalidDelegationPlanError(`Task "${task.id}" requires a target`);
  }
  assertSerializable(task.input ?? {}, `task ${task.id} input`);
  if (task.type === "workflow") {
    if (context.workflows && !context.workflows.has(task.target)) {
      throw new UnknownWorkflowError(task.target);
    }
  } else if (context.agents && !context.agents.has(task.target)) {
    throw new UnknownAgentError(task.target);
  }
  if (context.authorize && !context.authorize(task.type, task.target)) {
    throw new InvalidDelegationPlanError(`Caller is not permitted to invoke ${task.type} "${task.target}"`);
  }
}

function assertAcyclic(tasks: DelegationTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new CircularDependencyError(`Delegation plan contains a cycle at "${id}"`);
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) {
    visit(task.id);
  }
}

export function planWaves(tasks: DelegationTask[]): DelegationTask[][] {
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const waves: DelegationTask[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) =>
      (task.dependsOn ?? []).every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) {
      throw new CircularDependencyError();
    }
    waves.push(ready);
    for (const task of ready) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
  }
  return waves;
}
