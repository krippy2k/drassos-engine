import { RunNotFoundError } from "../core/errors.ts";
import type {
  AgentRunRecord,
  AgentRunStatus,
  ExecutionMetadata,
  ExecutionNode,
  ExecutionStatus,
  WorkflowRun,
  WorkflowStatus,
} from "../core/types.ts";
import type { Store } from "../persistence/store.ts";

function toDate(value: string | null | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function workflowStatus(status: WorkflowStatus): ExecutionStatus {
  return status;
}

function agentStatus(status: AgentRunStatus): ExecutionStatus {
  if (status === "WAITING_FOR_TOOL" || status === "WAITING_FOR_HUMAN") {
    return "WAITING";
  }
  if (status === "TIMED_OUT") {
    return "TIMED_OUT";
  }
  return status;
}

export function workflowToExecution(run: WorkflowRun): ExecutionMetadata {
  return {
    id: run.id,
    executionId: run.id,
    type: "workflow",
    name: run.workflowName,
    status: workflowStatus(run.status),
    parentExecutionId: run.parentRunId,
    rootExecutionId: run.rootRunId || run.id,
    depth: run.childDepth,
    createdAt: new Date(run.createdAt),
    startedAt: toDate(run.startedAt),
    completedAt: toDate(run.completedAt),
    originatingStepId: run.parentStepId,
    cancellationPolicy: run.cancellationPolicy,
    failurePolicy: run.failurePolicy,
    timeoutAt: toDate(run.timeoutAt),
  };
}

export function agentToExecution(run: AgentRunRecord): ExecutionMetadata {
  return {
    id: run.id,
    executionId: run.id,
    type: "agent",
    name: run.agentName,
    status: agentStatus(run.status),
    parentExecutionId: run.parentExecutionId,
    rootExecutionId: run.rootExecutionId,
    depth: run.depth,
    createdAt: new Date(run.startedAt),
    startedAt: toDate(run.startedAt),
    completedAt: toDate(run.completedAt),
    originatingStepId: run.stepRunId,
    cancellationPolicy: run.cancellationPolicy,
    failurePolicy: run.failurePolicy,
  };
}

export async function loadExecution(store: Store, executionId: string): Promise<ExecutionMetadata | null> {
  const workflow = await store.getRun(executionId);
  if (workflow) {
    return workflowToExecution(workflow);
  }
  const agent = await store.getAgentRun(executionId);
  if (agent) {
    return agentToExecution(agent);
  }
  return null;
}

export async function listChildExecutions(store: Store, executionId: string): Promise<ExecutionMetadata[]> {
  const [workflows, agents] = await Promise.all([
    store.listChildren(executionId),
    store.listAgentRunsByParentExecution(executionId),
  ]);
  const mapped = [
    ...workflows.map(workflowToExecution),
    ...agents.filter((agent) => agent.id !== executionId).map(agentToExecution),
  ];
  mapped.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return mapped;
}

export async function buildExecutionTree(store: Store, executionId: string): Promise<ExecutionNode> {
  const execution = await loadExecution(store, executionId);
  if (!execution) {
    throw new RunNotFoundError(executionId);
  }
  const children = await listChildExecutions(store, executionId);
  return {
    executionId: execution.id,
    type: execution.type,
    name: execution.name,
    status: execution.status,
    children: await Promise.all(children.map((child) => buildExecutionTree(store, child.id))),
  };
}
