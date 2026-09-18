import type {
  DurableTimer,
  HistoryEvent,
  HumanInteraction,
  HumanTask,
  StepRun,
  WorkflowRun,
} from "../core/types.ts";
import type { HistoricalSnapshot } from "./types.ts";

export function snapshotAt(
  history: HistoryEvent[],
  seq: number,
  source: {
    run: WorkflowRun;
    steps: StepRun[];
    timers: DurableTimer[];
    tasks: HumanTask[];
    interactions: HumanInteraction[];
    children: WorkflowRun[];
    agentOutputs: Array<{ id: string; name: string; output: unknown; status: string; startedAt: string }>;
  },
): HistoricalSnapshot {
  const events = history.filter((event) => event.seq <= seq).sort((a, b) => a.seq - b.seq);
  const last = events[events.length - 1];
  const completedNames = new Set(
    events.filter((event) => event.type === "step.completed").map((event) => String((event.payload as { name?: string }).name ?? "")),
  );
  const failedNames = new Set(
    events.filter((event) => event.type === "step.failed").map((event) => String((event.payload as { name?: string }).name ?? "")),
  );
  const cutoff = last ? new Date(last.timestamp).getTime() : 0;

  const completedSteps = source.steps
    .filter((step) => completedNames.has(step.name) || (step.completedAt && new Date(step.completedAt).getTime() <= cutoff && step.status === "COMPLETED"))
    .map((step) => ({ id: step.id, name: step.name, type: step.type, output: step.output }));

  const pendingSteps = source.steps
    .filter((step) => !completedSteps.some((item) => item.id === step.id))
    .filter((step) => !step.startedAt || new Date(step.startedAt).getTime() <= cutoff)
    .map((step) => ({
      id: step.id,
      name: step.name,
      type: step.type,
      status: failedNames.has(step.name) ? "FAILED" : step.status,
    }));

  const pendingTimers = source.timers.filter((timer) => {
    if (timer.status === "fired" && timer.firedAt && new Date(timer.firedAt).getTime() <= cutoff) {
      return false;
    }
    return true;
  });

  const pendingHuman = [
    ...source.tasks.filter((task) => task.status === "pending" || !task.completedAt || new Date(task.completedAt).getTime() > cutoff),
    ...source.interactions.filter((item) => item.status === "pending" || !item.completedAt || new Date(item.completedAt).getTime() > cutoff),
  ].map((item) => ({
    id: "interactionId" in item ? item.interactionId : item.id,
    title: item.title,
    status: item.status,
  }));

  const pendingSignals = events
    .filter((event) => event.type === "signal.wait.started")
    .map((event) => String((event.payload as { name?: string }).name ?? event.type))
    .filter((name) => !events.some((event) => event.type === "signal.wait.completed" && String((event.payload as { name?: string }).name ?? "") === name));

  let runStatus = "PENDING";
  for (const event of events) {
    if (event.type === "workflow.started") {
      runStatus = "RUNNING";
    }
    if (event.type === "workflow.waiting") {
      runStatus = "WAITING";
    }
    if (event.type === "workflow.resumed") {
      runStatus = "RUNNING";
    }
    if (event.type === "workflow.completed") {
      runStatus = "COMPLETED";
    }
    if (event.type === "workflow.failed") {
      runStatus = "FAILED";
    }
    if (event.type === "workflow.cancelled") {
      runStatus = "CANCELLED";
    }
  }

  return {
    seq,
    timestamp: last?.timestamp ?? null,
    runStatus,
    waitType: source.run.waitType,
    completedSteps,
    pendingSteps,
    pendingTimers: pendingTimers.map((timer) => ({ id: timer.id, fireAt: timer.fireAt, status: timer.status })),
    pendingHuman,
    pendingSignals,
    children: source.children.map((child) => ({ id: child.id, workflowName: child.workflowName, status: child.status })),
    agentOutputs: source.agentOutputs.filter((agent) => new Date(agent.startedAt).getTime() <= cutoff || cutoff === 0),
  };
}
