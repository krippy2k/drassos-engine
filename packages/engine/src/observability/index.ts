import type { Store } from "../persistence/store.ts";
import type { ObservabilityConfig } from "../core/types.ts";
import { graphFromTrace } from "./graph.ts";
import { computeMetrics } from "./metrics.ts";
import { snapshotAt } from "./snapshot.ts";
import { buildTrace } from "./trace.ts";
import { estimateRunCostUsd } from "./cost.ts";
import { durationMs } from "./status.ts";
import type { ExecutionGraph, HistoricalSnapshot, ObservableOperation, ObservabilityMetrics, RunListItem, RunQuery } from "./types.ts";

export class Observability {
  constructor(
    private readonly store: Store,
    private readonly config?: ObservabilityConfig,
  ) {}

  async listRuns(query: RunQuery = {}): Promise<{ runs: RunListItem[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const { rows, total } = await this.store.queryRuns({
      workflow: query.workflow,
      status: query.status,
      agent: query.agent,
      worker: query.worker,
      from: query.from,
      to: query.to,
      failed: query.failed,
      minDurationMs: query.minDurationMs,
      maxDurationMs: query.maxDurationMs,
      limit,
      offset,
    });
    const modelCalls = await this.store.listModelCallsForRuns(rows.map((run) => run.id)).catch(() => []);
    const costByRun = new Map<string, number | null>();
    for (const run of rows) {
      costByRun.set(run.id, null);
    }
    const callsByRun = new Map<string, typeof modelCalls>();
    for (const call of modelCalls) {
      const bucket = callsByRun.get(call.runId) ?? [];
      bucket.push(call);
      callsByRun.set(call.runId, bucket);
    }
    for (const [runId, calls] of callsByRun) {
      costByRun.set(runId, estimateRunCostUsd(calls, this.config));
    }
    const runs: RunListItem[] = [];
    for (const run of rows) {
      const steps = await this.store.listSteps(run.id);
      const current =
        steps.find((step) => step.status === "RUNNING" || step.status === "WAITING" || step.status === "RETRYING") ??
        steps[steps.length - 1];
      runs.push({
        id: run.id,
        workflowName: run.workflowName,
        workflowVersion: run.workflowVersion,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: durationMs(run.startedAt ?? run.createdAt, run.completedAt),
        currentStep: current?.name ?? null,
        estimatedCostUsd: costByRun.get(run.id) ?? null,
        error: run.error,
        parentRunId: run.parentRunId,
        forkedFromRunId: run.forkedFromRunId,
        forkedFromSeq: run.forkedFromSeq,
      });
    }
    return { runs, total, limit, offset };
  }

  async estimateRunCost(runId: string): Promise<number | null> {
    const calls = await this.store.listModelCallsForRun(runId).catch(() => []);
    return estimateRunCostUsd(calls, this.config);
  }

  async trace(runId: string): Promise<ObservableOperation | null> {
    const source = await this.load(runId);
    if (!source) {
      return null;
    }
    return buildTrace(source, this.config);
  }

  async graph(runId: string): Promise<ExecutionGraph | null> {
    const trace = await this.trace(runId);
    if (!trace) {
      return null;
    }
    return graphFromTrace(trace);
  }

  async snapshot(runId: string, seq: number): Promise<HistoricalSnapshot | null> {
    const source = await this.load(runId);
    if (!source) {
      return null;
    }
    return snapshotAt(source.history, seq, {
      run: source.run,
      steps: source.steps,
      timers: source.timers,
      tasks: source.tasks,
      interactions: source.interactions,
      children: source.children,
      agentOutputs: source.agentRuns.map((agent) => ({
        id: agent.id,
        name: agent.agentName,
        output: agent.output,
        status: agent.status,
        startedAt: agent.startedAt,
      })),
    });
  }

  async metrics(): Promise<ObservabilityMetrics> {
    const runs = await this.store.listRuns({ limit: 500 });
    const waiting = await this.store.listInteractions({ status: "pending" }).catch(() => []);
    const retryEvents = await this.store.countHistoryType("step.retrying").catch(() => 0);
    const modelCalls = await this.store.listRecentModelCalls(500).catch(() => []);
    const toolCalls = await this.store.listRecentToolCalls(500).catch(() => []);
    const agentRuns = await this.store.listRecentAgentRuns(500).catch(() => []);
    const replay = await this.store.replayStats().catch(() => ({ attempts: 0, successes: 0, divergences: 0, durations: [] as number[] }));
    const waitingWorkers = await this.store.countWaitingForWorker().catch(() => 0);
    const executionsByVersion = await this.store.listVersionCounts().catch(() => []);
    const workers = await this.store.listWorkers().catch(() => []);
    const workerCounts = new Map<string, number>();
    for (const worker of workers) {
      for (const version of worker.workflowVersions) {
        workerCounts.set(version, (workerCounts.get(version) ?? 0) + 1);
      }
    }
    return computeMetrics(runs, {
      agentRuns,
      toolCalls,
      modelCalls,
      waitingHuman: waiting.length,
      retryEvents,
      config: this.config,
      replayAttempts: replay.attempts,
      replaySuccesses: replay.successes,
      replayDivergences: replay.divergences,
      replayDurations: replay.durations,
      waitingCompatibleWorkers: waitingWorkers,
      executionsByVersion,
      workersByVersion: [...workerCounts.entries()].map(([version, count]) => ({ version, workers: count })),
    });
  }

  private async load(runId: string) {
    const run = await this.store.getRun(runId);
    if (!run) {
      return null;
    }
    const [steps, history, tasks, timers, agentRuns, toolCalls, modelCalls, interactions, children] = await Promise.all([
      this.store.listSteps(runId),
      this.store.listHistory(runId),
      this.store.listHumanTasks({ runId }),
      this.store.listTimers(runId),
      this.store.listAgentRuns(runId),
      this.store.listToolCalls({ runId }),
      this.store.listModelCallsForRun(runId),
      this.store.listInteractions({ runId }),
      this.store.listChildren(runId),
    ]);
    return { run, steps, history, tasks, timers, agentRuns, toolCalls, modelCalls, interactions, children };
  }
}
