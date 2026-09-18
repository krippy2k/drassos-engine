import type { AgentRunRecord, ModelCallRecord, ToolCallRecord, WorkflowRun } from "../core/types.ts";
import { estimateModelCostUsd } from "./cost.ts";
import { durationMs, percentiles } from "./status.ts";
import type { ObservabilityMetrics } from "./types.ts";
import type { ObservabilityConfig } from "../core/types.ts";

export function computeMetrics(
  runs: WorkflowRun[],
  extras?: {
    agentRuns?: AgentRunRecord[];
    toolCalls?: ToolCallRecord[];
    modelCalls?: ModelCallRecord[];
    waitingHuman?: number;
    retryEvents?: number;
    config?: ObservabilityConfig;
    replayAttempts?: number;
    replaySuccesses?: number;
    replayDivergences?: number;
    replayDurations?: number[];
    waitingCompatibleWorkers?: number;
    executionsByVersion?: Array<{ workflowName: string; version: string; count: number }>;
    workersByVersion?: Array<{ version: string; workers: number }>;
  },
): ObservabilityMetrics {
  const active = runs.filter((run) => run.status === "RUNNING" || run.status === "PENDING" || run.status === "WAITING").length;
  const completed = runs.filter((run) => run.status === "COMPLETED").length;
  const failed = runs.filter((run) => run.status === "FAILED").length;
  const cancelled = runs.filter((run) => run.status === "CANCELLED").length;
  const settled = completed + failed;
  const workflowLatency = percentiles(
    runs
      .map((run) => durationMs(run.startedAt ?? run.createdAt, run.completedAt))
      .filter((value): value is number => value !== null),
  );
  const agentLatency = percentiles(
    (extras?.agentRuns ?? [])
      .map((run) => durationMs(run.startedAt, run.completedAt))
      .filter((value): value is number => value !== null),
  );
  const tools = extras?.toolCalls ?? [];
  const toolLatency = percentiles(
    tools.map((call) => durationMs(call.startedAt, call.completedAt)).filter((value): value is number => value !== null),
  );
  const toolFailed = tools.filter((call) => call.status === "FAILED").length;
  const models = extras?.modelCalls ?? [];
  const tokenInput = models.reduce((sum, call) => sum + (call.tokenInput ?? 0), 0);
  const tokenOutput = models.reduce((sum, call) => sum + (call.tokenOutput ?? 0), 0);
  const estimatedCostUsd = models.reduce((sum, call) => sum + (estimateModelCostUsd(call, extras?.config) ?? 0), 0);
  const retryEvents = extras?.retryEvents ?? 0;
  const operations = Math.max(1, extras?.agentRuns?.length ?? 0) + tools.length + runs.length;
  return {
    active,
    completed,
    failed,
    cancelled,
    waitingHuman: extras?.waitingHuman ?? runs.filter((run) => run.status === "WAITING" && run.waitType === "human").length,
    successRate: settled === 0 ? 0 : completed / settled,
    retryRate: retryEvents / operations,
    toolFailureRate: tools.length === 0 ? 0 : toolFailed / tools.length,
    workflowLatency,
    agentLatency,
    toolLatency,
    tokenInput,
    tokenOutput,
    estimatedCostUsd,
    replayAttempts: extras?.replayAttempts ?? 0,
    replaySuccesses: extras?.replaySuccesses ?? 0,
    replayDivergences: extras?.replayDivergences ?? 0,
    replayDuration: percentiles(extras?.replayDurations ?? []),
    waitingCompatibleWorkers: extras?.waitingCompatibleWorkers ?? runs.filter((run) => run.waitType === "compatible-worker").length,
    executionsByVersion: extras?.executionsByVersion ?? [],
    workersByVersion: extras?.workersByVersion ?? [],
  };
}
