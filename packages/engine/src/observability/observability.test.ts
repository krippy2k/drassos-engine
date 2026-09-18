import { describe, expect, it } from "vitest";
import {
  applyCapture,
  buildTrace,
  computeMetrics,
  durationMs,
  estimateModelCostUsd,
  flattenOperations,
  graphFromTrace,
  mapEngineStatus,
  percentiles,
  redactSecrets,
  snapshotAt,
} from "../index.ts";
import type { HistoryEvent, ModelCallRecord, StepRun, WorkflowRun } from "../index.ts";

function run(patch: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowName: "demo",
    workflowVersion: "1",
    input: { secretToken: "abc", city: "Portland" },
    output: { ok: true },
    status: "COMPLETED",
    error: null,
    cancellation: null,
    waitType: null,
    waitRef: null,
    parentRunId: null,
    parentStepId: null,
    childDepth: 0,
    cancelOnParentCancel: true,
    rootRunId: "run-1",
    failurePolicy: "fail-parent",
    cancellationPolicy: "propagate",
    timeoutAt: null,
    forkedFromRunId: null,
    forkedFromSeq: null,
    historyFormatVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    ...patch,
  };
}

describe("observability mapping", () => {
  it("maps engine statuses and durations", () => {
    expect(mapEngineStatus("WAITING")).toBe("waiting");
    expect(mapEngineStatus("RETRYING")).toBe("retrying");
    expect(mapEngineStatus("TIMED_OUT")).toBe("timed_out");
    expect(durationMs("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.250Z")).toBe(1250);
    expect(percentiles([1, 2, 3, 4, 100]).p50).toBe(3);
  });

  it("redacts secrets and honors payload capture modes", () => {
    expect(redactSecrets({ password: "x", city: "Oslo" })).toEqual({ password: "[redacted]", city: "Oslo" });
    expect(applyCapture({ a: 1 }, "disabled")).toBeUndefined();
    expect(applyCapture({ a: 1, b: 2 }, "metadata-only")).toEqual({ type: "object", keys: ["a", "b"] });
  });

  it("estimates model cost from tokens", () => {
    const call = { model: "gpt-4o", tokenInput: 1_000_000, tokenOutput: 0 } as ModelCallRecord;
    expect(estimateModelCostUsd(call)).toBeCloseTo(2.5);
  });

  it("builds a hierarchy and graph from mixed operations", () => {
    const step: StepRun = {
      id: "step-agent",
      runId: "run-1",
      name: "researcher",
      occurrence: 0,
      type: "agent",
      input: { q: "hi" },
      output: { ok: true },
      status: "COMPLETED",
      attempt: 1,
      maxAttempts: 1,
      error: null,
      timeoutMs: null,
      idempotencyKey: null,
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:04.000Z",
    };
    const trace = buildTrace({
      run: run(),
      steps: [step],
      agentRuns: [
        {
          id: "agent-1",
          runId: "run-1",
          stepRunId: "step-agent",
          agentName: "researcher",
          status: "COMPLETED",
          currentTurn: 1,
          toolCallCount: 1,
          modelCallCount: 1,
          limits: {},
          output: { brief: "ok" },
          error: null,
          parentAgentRunId: null,
          parentExecutionId: "run-1",
          rootExecutionId: "run-1",
          depth: 1,
          failurePolicy: "fail-parent",
          cancellationPolicy: "propagate",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:04.000Z",
        },
      ],
      modelCalls: [
        {
          id: "model-1",
          agentRunId: "agent-1",
          agentTurnId: "turn-1",
          runId: "run-1",
          provider: "demo",
          model: "demo",
          request: { prompt: "secretToken should stay unless key matches" },
          response: { text: "hi" },
          tokenInput: 10,
          tokenOutput: 4,
          latencyMs: 12,
          stopReason: "stop",
          attempt: 1,
          error: null,
          startedAt: "2026-01-01T00:00:01.100Z",
          completedAt: "2026-01-01T00:00:01.200Z",
        },
      ],
      toolCalls: [
        {
          id: "tool-1",
          agentRunId: "agent-1",
          agentTurnId: "turn-1",
          runId: "run-1",
          name: "lookup",
          source: "mcp",
          server: "market",
          arguments: { q: "x" },
          result: { ok: true },
          status: "COMPLETED",
          attempt: 1,
          idempotencyKey: null,
          error: null,
          startedAt: "2026-01-01T00:00:01.300Z",
          completedAt: "2026-01-01T00:00:01.400Z",
        },
      ],
      tasks: [],
      interactions: [],
      timers: [],
      children: [],
      history: [],
    });
    expect(trace.type).toBe("workflow");
    expect(trace.children[0]?.type).toBe("agent");
    const kinds = new Set(flattenOperations(trace).map((node) => node.type));
    expect(kinds.has("model")).toBe(true);
    expect(kinds.has("mcp")).toBe(true);
    const graph = graphFromTrace(trace);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.edges.length).toBeGreaterThanOrEqual(3);
    expect(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("redacts workflow secrets in traces", () => {
    const trace = buildTrace({
      run: run(),
      steps: [],
      agentRuns: [],
      modelCalls: [],
      toolCalls: [],
      tasks: [],
      interactions: [],
      timers: [],
      children: [],
      history: [],
    });
    expect(trace.input).toMatchObject({ secretToken: "[redacted]", city: "Portland" });
  });

  it("builds a historical snapshot from event seq", () => {
    const history: HistoryEvent[] = [
      { id: "1", runId: "run-1", seq: 1, type: "workflow.started", timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
      { id: "2", runId: "run-1", seq: 2, type: "step.completed", timestamp: "2026-01-01T00:00:02.000Z", payload: { name: "load" } },
      { id: "3", runId: "run-1", seq: 3, type: "workflow.waiting", timestamp: "2026-01-01T00:00:03.000Z", payload: {} },
    ];
    const snap = snapshotAt(history, 2, {
      run: run({ status: "WAITING", waitType: "human" }),
      steps: [
        {
          id: "s1",
          runId: "run-1",
          name: "load",
          occurrence: 0,
          type: "step",
          input: {},
          output: { n: 1 },
          status: "COMPLETED",
          attempt: 1,
          maxAttempts: 1,
          error: null,
          timeoutMs: null,
          idempotencyKey: null,
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      timers: [],
      tasks: [],
      interactions: [],
      children: [],
      agentOutputs: [],
    });
    expect(snap.runStatus).toBe("RUNNING");
    expect(snap.completedSteps).toHaveLength(1);
  });

  it("computes aggregate metrics", () => {
    const metrics = computeMetrics([run(), run({ id: "run-2", status: "FAILED", error: { name: "Error", message: "x", type: "user", timestamp: "t" } })]);
    expect(metrics.completed).toBe(1);
    expect(metrics.failed).toBe(1);
    expect(metrics.successRate).toBe(0.5);
  });

  it("applies metadata-only and disabled payload capture", () => {
    const empty = {
      steps: [],
      agentRuns: [],
      modelCalls: [],
      toolCalls: [],
      tasks: [],
      interactions: [],
      timers: [],
      children: [],
      history: [],
    };
    const metadata = buildTrace({ run: run(), ...empty }, { payloads: "metadata-only" });
    expect(metadata.input).toEqual({ type: "object", keys: ["secretToken", "city"] });
    const disabled = buildTrace({ run: run(), ...empty }, { payloads: "disabled" });
    expect(disabled.input).toBeUndefined();
  });
});
