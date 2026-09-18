import type {
  AgentRunRecord,
  DurableTimer,
  HistoryEvent,
  HumanInteraction,
  HumanTask,
  ModelCallRecord,
  ObservabilityConfig,
  StepRun,
  ToolCallRecord,
  WorkflowRun,
} from "../core/types.ts";
import { applyCapture, resolveCapture } from "./redact.ts";
import { durationMs, mapEngineStatus } from "./status.ts";
import { estimateModelCostUsd } from "./cost.ts";
import type { ObservableKind, ObservableOperation } from "./types.ts";

export interface TraceSource {
  run: WorkflowRun;
  steps: StepRun[];
  agentRuns: AgentRunRecord[];
  modelCalls: ModelCallRecord[];
  toolCalls: ToolCallRecord[];
  tasks: HumanTask[];
  interactions: HumanInteraction[];
  timers: DurableTimer[];
  children: WorkflowRun[];
  history: HistoryEvent[];
  workerId?: string | null;
}

export function buildTrace(source: TraceSource, config?: ObservabilityConfig, now = Date.now()): ObservableOperation {
  const traceId = source.run.rootRunId || source.run.id;
  const run = source.run;
  const workflow: ObservableOperation = operation({
    id: run.id,
    type: "workflow",
    name: run.workflowName,
    parentId: run.parentRunId,
    workflowId: run.workflowName,
    runId: run.id,
    status: mapEngineStatus(run.status === "WAITING" ? "WAITING" : run.status),
    startedAt: run.startedAt ?? run.createdAt,
    completedAt: run.completedAt,
    attempt: 1,
    workerId: source.workerId ?? null,
    input: applyCapture(run.input, resolveCapture(config, "workflowInputs")),
    output: applyCapture(run.output, resolveCapture(config, "workflowOutputs")),
    error: run.error,
    attributes: {
      version: run.workflowVersion,
      waitType: run.waitType,
      forkedFromRunId: run.forkedFromRunId,
      forkedFromSeq: run.forkedFromSeq,
    },
    traceId,
    now,
  });
  if (run.status === "WAITING") {
    workflow.status = "waiting";
  }

  const stepNodes = source.steps.map((step) => {
    const kind: ObservableKind =
      step.type === "activity"
        ? "activity"
        : step.type === "agent"
          ? "agent"
          : step.type === "human"
            ? "human"
            : step.type === "child"
              ? "child"
              : step.type === "timer"
                ? "timer"
                : step.type === "signal"
                  ? "signal"
                  : "step";
    return operation({
      id: step.id,
      type: kind,
      name: step.name,
      parentId: run.id,
      workflowId: run.workflowName,
      runId: run.id,
      status: mapEngineStatus(step.status),
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      attempt: step.attempt,
      workerId: null,
      input: applyCapture(step.input, resolveCapture(config, "agentInputs")),
      output: applyCapture(step.output, resolveCapture(config, "agentOutputs")),
      error: step.error,
      attributes: { stepType: step.type, occurrence: step.occurrence, maxAttempts: step.maxAttempts },
      traceId,
      now,
    });
  });

  const agentsByStep = new Map<string, ObservableOperation[]>();
  for (const agent of source.agentRuns) {
    const node = operation({
      id: agent.id,
      type: "agent",
      name: agent.agentName,
      parentId: agent.stepRunId || run.id,
      workflowId: run.workflowName,
      runId: run.id,
      status: mapEngineStatus(agent.status),
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      attempt: 1,
      workerId: null,
      input: applyCapture(null, resolveCapture(config, "agentInputs")),
      output: applyCapture(agent.output, resolveCapture(config, "agentOutputs")),
      error: agent.error,
      attributes: {
        turns: agent.currentTurn,
        toolCallCount: agent.toolCallCount,
        modelCallCount: agent.modelCallCount,
      },
      traceId,
      now,
    });
    const models = source.modelCalls.filter((call) => call.agentRunId === agent.id).map((call) => {
      const cost = estimateModelCostUsd(call, config);
      return operation({
        id: call.id,
        type: "model",
        name: call.model ?? call.provider,
        parentId: agent.id,
        workflowId: run.workflowName,
        runId: run.id,
        status: mapEngineStatus(call.error ? "FAILED" : call.completedAt ? "COMPLETED" : "RUNNING"),
        startedAt: call.startedAt,
        completedAt: call.completedAt,
        attempt: call.attempt,
        workerId: null,
        input: applyCapture(call.request, resolveCapture(config, "modelPrompts")),
        output: applyCapture(call.response, resolveCapture(config, "modelResponses")),
        error: call.error,
        attributes: {
          provider: call.provider,
          model: call.model,
          tokenInput: call.tokenInput,
          tokenOutput: call.tokenOutput,
          latencyMs: call.latencyMs,
          estimatedCostUsd: cost,
          stopReason: call.stopReason,
        },
        traceId,
        now,
      });
    });
    const tools = source.toolCalls.filter((call) => call.agentRunId === agent.id).map((call) =>
      operation({
        id: call.id,
        type: call.source === "mcp" ? "mcp" : "tool",
        name: call.server ? `${call.server}.${call.name}` : call.name,
        parentId: agent.id,
        workflowId: run.workflowName,
        runId: run.id,
        status: mapEngineStatus(call.status),
        startedAt: call.startedAt,
        completedAt: call.completedAt,
        attempt: call.attempt,
        workerId: null,
        input: applyCapture(call.arguments, resolveCapture(config, "toolArguments")),
        output: applyCapture(call.result, resolveCapture(config, "toolResults")),
        error: call.error,
        attributes: { source: call.source, server: call.server },
        traceId,
        now,
      }),
    );
    node.children = [...models, ...tools];
    const list = agentsByStep.get(agent.stepRunId) ?? [];
    list.push(node);
    agentsByStep.set(agent.stepRunId, list);
  }

  const humansByStep = new Map<string, ObservableOperation[]>();
  for (const task of source.tasks) {
    const node = operation({
      id: task.id,
      type: "human",
      name: task.title || task.name,
      parentId: task.stepRunId || run.id,
      workflowId: run.workflowName,
      runId: run.id,
      status: mapEngineStatus(task.status),
      startedAt: task.createdAt,
      completedAt: task.completedAt,
      attempt: 1,
      workerId: null,
      input: applyCapture(task.data, resolveCapture(config, "agentInputs")),
      output: applyCapture(task.response, resolveCapture(config, "agentOutputs")),
      error: null,
      attributes: { assignedTo: task.assignedTo },
      traceId,
      now,
    });
    const list = humansByStep.get(task.stepRunId) ?? [];
    list.push(node);
    humansByStep.set(task.stepRunId, list);
  }
  for (const interaction of source.interactions) {
    const node = operation({
      id: interaction.id,
      type: "human",
      name: interaction.title,
      parentId: interaction.stepRunId || run.id,
      workflowId: run.workflowName,
      runId: run.id,
      status: mapEngineStatus(interaction.status),
      startedAt: interaction.createdAt,
      completedAt: interaction.completedAt,
      attempt: 1,
      workerId: null,
      input: applyCapture(interaction.metadata ?? interaction.description, resolveCapture(config, "agentInputs")),
      output: applyCapture(interaction.decision, resolveCapture(config, "agentOutputs")),
      error: null,
      attributes: { interactionId: interaction.interactionId, kind: interaction.type },
      traceId,
      now,
    });
    const list = humansByStep.get(interaction.stepRunId) ?? [];
    list.push(node);
    humansByStep.set(interaction.stepRunId, list);
  }

  const childrenByStep = new Map<string, ObservableOperation[]>();
  for (const child of source.children) {
    const parentStep = child.parentStepId ?? run.id;
    const node = operation({
      id: child.id,
      type: "child",
      name: child.workflowName,
      parentId: parentStep,
      workflowId: run.workflowName,
      runId: child.id,
      status: mapEngineStatus(child.status),
      startedAt: child.startedAt ?? child.createdAt,
      completedAt: child.completedAt,
      attempt: 1,
      workerId: null,
      input: applyCapture(child.input, resolveCapture(config, "workflowInputs")),
      output: applyCapture(child.output, resolveCapture(config, "workflowOutputs")),
      error: child.error,
      attributes: { childRunId: child.id },
      traceId,
      now,
    });
    const list = childrenByStep.get(parentStep) ?? [];
    list.push(node);
    childrenByStep.set(parentStep, list);
  }

  const timersByStep = new Map<string, ObservableOperation[]>();
  for (const timer of source.timers) {
    const node = operation({
      id: timer.id,
      type: "timer",
      name: "timer",
      parentId: timer.stepRunId || run.id,
      workflowId: run.workflowName,
      runId: run.id,
      status: mapEngineStatus(timer.status),
      startedAt: timer.fireAt,
      completedAt: timer.firedAt,
      attempt: 1,
      workerId: null,
      input: { fireAt: timer.fireAt },
      output: timer.firedAt ? { firedAt: timer.firedAt } : null,
      error: null,
      attributes: {},
      traceId,
      now,
    });
    const list = timersByStep.get(timer.stepRunId) ?? [];
    list.push(node);
    timersByStep.set(timer.stepRunId, list);
  }

  for (const step of stepNodes) {
    step.children = [
      ...(agentsByStep.get(step.id) ?? []),
      ...(humansByStep.get(step.id) ?? []),
      ...(childrenByStep.get(step.id) ?? []),
      ...(timersByStep.get(step.id) ?? []),
    ];
  }

  const attached = new Set(stepNodes.map((step) => step.id));
  const orphans: ObservableOperation[] = [];
  for (const [stepId, nodes] of [
    ...agentsByStep.entries(),
    ...humansByStep.entries(),
    ...childrenByStep.entries(),
    ...timersByStep.entries(),
  ]) {
    if (!attached.has(stepId) && stepId !== run.id) {
      orphans.push(...nodes);
    }
  }

  workflow.children = [...stepNodes, ...orphans.filter((node) => node.parentId === run.id)];
  return workflow;
}

function operation(input: {
  id: string;
  type: ObservableKind;
  name: string;
  parentId: string | null;
  workflowId: string;
  runId: string;
  status: ReturnType<typeof mapEngineStatus>;
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
  workerId: string | null;
  input: unknown;
  output: unknown;
  error: ObservableOperation["error"];
  attributes: ObservableOperation["attributes"];
  traceId: string;
  now: number;
}): ObservableOperation {
  return {
    ...input,
    durationMs: durationMs(input.startedAt, input.completedAt, input.now),
    spanId: input.id,
    children: [],
  };
}
