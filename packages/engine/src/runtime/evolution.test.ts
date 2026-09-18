import { afterEach, describe, expect, it } from "vitest";
import {
  CompatibleWorkerMissing,
  HISTORY_FORMAT_VERSION,
  UnsupportedHistoryFormatError,
  WorkflowRegistrationError,
  Worker,
  assertHistoryFormat,
  createDrassos,
  exportExecution,
  isValidWorkflowVersion,
  parseWorkflowKey,
  parseWorkflowVersion,
  replayDefinition,
  workflow,
  workflowKey,
  type ExecutionExport,
} from "../index.ts";
import { WorkflowRegistry } from "./registry.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

describe("workflow version identity", () => {
  it("parses semver-like versions including shorthand 1 and 1.0", () => {
    expect(isValidWorkflowVersion("1")).toBe(true);
    expect(isValidWorkflowVersion("1.0")).toBe(true);
    expect(isValidWorkflowVersion("1.0.0")).toBe(true);
    expect(isValidWorkflowVersion("2.0.0-beta.1")).toBe(true);
    expect(isValidWorkflowVersion("")).toBe(false);
    expect(isValidWorkflowVersion("v1")).toBe(false);
    expect(parseWorkflowVersion("1.4.0")).toEqual({ major: 1, minor: 4, patch: 0, prerelease: null });
    expect(workflowKey("order-processing", "2.0.0")).toBe("order-processing@2.0.0");
    expect(parseWorkflowKey("order-processing@2.0.0")).toEqual({ name: "order-processing", version: "2.0.0" });
  });

  it("rejects duplicate registrations and invalid versions", () => {
    const registry = new WorkflowRegistry();
    const v1 = workflow("orders", { version: "1.0.0", run: async () => "one" });
    registry.register(v1);
    expect(() => registry.register(v1)).toThrow(WorkflowRegistrationError);
    expect(() => workflow("orders", { version: "not-a-version", run: async () => "x" })).toThrow(WorkflowRegistrationError);
    const enforced = new WorkflowRegistry({ enforceVersions: true });
    expect(() => enforced.register(workflow("orders", async () => "x", { version: "1" }))).toThrow(WorkflowRegistrationError);
    enforced.register(workflow("orders", { version: "1.0.0", run: async () => "x" }));
  });

  it("binds executions to the selected version", async () => {
    const v1 = workflow("bind-me", { version: "1.0.0", run: async () => "v1" });
    const v2 = workflow("bind-me", { version: "2.0.0", run: async () => "v2" });
    const engine = await createDrassos({ inMemory: true, workflows: [v1, v2], pollMs: 20, logLevel: "silent" });
    try {
      await engine.startWorker();
      const first = await engine.executor.startRun("bind-me", {}, undefined, { version: "1.0.0" });
      const second = await engine.executor.startRun("bind-me", {});
      await waitFor(async () => (await engine.store.getRun(first.id))?.status === "COMPLETED");
      await waitFor(async () => (await engine.store.getRun(second.id))?.status === "COMPLETED");
      expect((await engine.store.getRun(first.id))?.workflowVersion).toBe("1.0.0");
      expect((await engine.store.getRun(first.id))?.output).toBe("v1");
      expect((await engine.store.getRun(second.id))?.workflowVersion).toBe("2.0.0");
      expect((await engine.store.getRun(second.id))?.output).toBe("v2");
      expect((await engine.store.getRun(first.id))?.historyFormatVersion).toBe(HISTORY_FORMAT_VERSION);
    } finally {
      await engine.stop();
    }
  });
});

describe("deterministic replay", () => {
  it("replays recorded steps without calling user functions and reports divergence", async () => {
    let ran = 0;
    const original = workflow("replay-demo", {
      version: "1.0.0",
      run: async (ctx) => ctx.step("charge", async () => {
        ran += 1;
        return { ok: true };
      }),
    });
    const changed = workflow("replay-demo", {
      version: "1.1.0",
      run: async (ctx) => ctx.step("charge-v2", async () => {
        ran += 1;
        return { ok: true };
      }),
    });
    const bundle: ExecutionExport = {
      formatVersion: 1,
      execution: {
        id: "exec-1",
        workflow: "replay-demo",
        workflowVersion: "1.0.0",
        status: "COMPLETED",
        input: {},
        output: { ok: true },
        waitType: null,
        error: null,
      },
      history: [
        { id: "h1", runId: "exec-1", seq: 1, type: "workflow.started", timestamp: "2026-01-01T00:00:00.000Z", payload: {} },
      ],
      steps: [
        {
          id: "s1",
          runId: "exec-1",
          name: "charge",
          occurrence: 0,
          type: "step",
          input: {},
          output: { ok: true },
          status: "COMPLETED",
          attempt: 1,
          maxAttempts: 1,
          error: null,
          timeoutMs: null,
          idempotencyKey: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.100Z",
        },
      ],
      deterministicValues: [],
    };
    const ok = await replayDefinition(original, bundle);
    expect(ok.ok).toBe(true);
    expect(ran).toBe(0);
    const bad = await replayDefinition(changed, bundle);
    expect(bad.ok).toBe(false);
    expect(bad.divergences[0]?.kind).toBe("OPERATION_CHANGED");
    expect(ran).toBe(0);
    expect(() => assertHistoryFormat(99)).toThrow(UnsupportedHistoryFormatError);
  });

  it("records ctx.now/random/uuid and reproduces them on resume", async () => {
    const demo = workflow("clocked", {
      version: "1.0.0",
      run: async (ctx) => {
        const first = ctx.now().toISOString();
        await ctx.human("hold", { title: "pause" });
        const again = ctx.now().toISOString();
        return { first, again, n: ctx.random(), id: ctx.uuid() };
      },
    });
    const engine = await createDrassos({ inMemory: true, workflows: [demo], pollMs: 20, logLevel: "silent" });
    try {
      await engine.startWorker();
      const run = await engine.executor.startRun("clocked", {});
      await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
      const values = await engine.store.listDeterministicValues(run.id);
      expect(values.some((item) => item.kind === "now")).toBe(true);
      const tasks = await engine.store.listHumanTasks({ runId: run.id, status: "pending" });
      await engine.executor.completeHumanTask(tasks[0]!.id, { ok: true });
      await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
      const output = (await engine.store.getRun(run.id))?.output as { first: string; again: string; n: number; id: string };
      const recordedNow = values.find((item) => item.kind === "now" && item.occurrence === 0)?.value;
      expect(output.first).toBe(String(recordedNow));
      expect(typeof output.n).toBe("number");
      expect(output.id.length).toBeGreaterThan(8);
      const exported = await engine.exportExecution(run.id);
      expect(exported.deterministicValues.length).toBeGreaterThan(0);
      const replayed = await replayDefinition(demo, exported);
      expect(replayed.ok).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("redacts secrets in exported history", () => {
    const exported = exportExecution({
      run: {
        id: "r1",
        workflowName: "demo",
        workflowVersion: "1.0.0",
        input: { password: "hunter2", city: "Oslo" },
        output: { token: "abc" },
        status: "COMPLETED",
        error: null,
        cancellation: null,
        waitType: null,
        waitRef: null,
        parentRunId: null,
        parentStepId: null,
        childDepth: 0,
        cancelOnParentCancel: true,
        rootRunId: "r1",
        failurePolicy: "fail-parent",
        cancellationPolicy: "propagate",
        timeoutAt: null,
        forkedFromRunId: null,
        forkedFromSeq: null,
        historyFormatVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
      history: [],
      steps: [],
    });
    expect(exported.execution.input).toEqual({ password: "[redacted]", city: "Oslo" });
    expect(exported.formatVersion).toBe(1);
  });
});

describe("compatible worker routing", () => {
  it("does not fail a run when no compatible worker is present", async () => {
    const v1 = workflow("routed", {
      version: "1.0.0",
      run: async (ctx) => {
        await ctx.step("work", async () => "ok");
        return "v1";
      },
    });
    const v2 = workflow("routed", {
      version: "2.0.0",
      run: async () => "v2",
    });
    const engine = await createDrassos({
      inMemory: true,
      workflows: [v1, v2],
      pollMs: 20,
      leaseMs: 1_500,
      logLevel: "silent",
    });
    const workerB = new Worker({
      id: "only-v2",
      store: engine.store,
      executor: engine.executor,
      notifier: engine.notifier,
      logger: engine.logger,
      leaseMs: 1_500,
      pollMs: 20,
      workflowVersions: ["routed@2.0.0"],
    });
    try {
      await workerB.start();
      const run = await engine.executor.startRun("routed", {}, undefined, { version: "1.0.0" });
      await waitFor(async () => {
        const current = await engine.store.getRun(run.id);
        return current?.waitType === "compatible-worker" || (await engine.store.countWaitingForWorker()) > 0;
      });
      expect((await engine.store.getRun(run.id))?.status).not.toBe("FAILED");
      const missing = new CompatibleWorkerMissing("routed", "1.0.0");
      expect(missing.code).toBe("COMPATIBLE_WORKER_MISSING");
    } finally {
      await workerB.stop({ drain: false });
      await engine.stop();
    }
  });
});
