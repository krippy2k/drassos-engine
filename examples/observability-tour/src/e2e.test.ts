import { afterEach, describe, expect, it } from "vitest";
import { createDrassos } from "@drassos/engine";
import { createApi } from "@drassos/api";
import { createTourApp, demoState, resetDemoState } from "./index.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("observability tour", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    resetDemoState();
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("reconstructs the full execution through management APIs", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createTourApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const app = createApi({ drassos: engine });

    const created = await app.request("/workflows/observability-tour/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { topic: "workflow debugging", secretToken: "demo-secret" } }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };

    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");

    const listed = await app.request("/runs?workflow=observability-tour&status=WAITING");
    const listedBody = (await listed.json()) as { runs: Array<{ id: string; currentStep: string | null }>; total: number };
    expect(listedBody.runs.some((item) => item.id === run.id)).toBe(true);

    const aliased = await app.request("/api/runs?workflow=observability-tour");
    expect(((await aliased.json()) as { total: number }).total).toBeGreaterThan(0);

    const traceRes = await app.request(`/runs/${run.id}/trace`);
    const { trace } = (await traceRes.json()) as {
      trace: {
        type: string;
        input: Record<string, unknown>;
        children: Array<{ type: string; name: string; children: Array<{ type: string }> }>;
      };
    };
    expect(trace.type).toBe("workflow");
    expect(trace.input.secretToken).toBe("[redacted]");
    const researcher = trace.children.find((child) => child.name === "researcher" || child.type === "agent");
    expect(researcher).toBeTruthy();
    const kinds = new Set<string>();
    const walk = (node: { type: string; children?: Array<{ type: string; children?: never[] }> }) => {
      kinds.add(node.type);
      for (const child of node.children ?? []) {
        walk(child);
      }
    };
    walk(trace as never);
    expect(kinds.has("agent")).toBe(true);
    expect(kinds.has("model")).toBe(true);
    expect(kinds.has("tool")).toBe(true);
    expect(kinds.has("child")).toBe(true);
    expect(kinds.has("human")).toBe(true);

    const graphRes = await app.request(`/runs/${run.id}/graph`);
    const graph = (await graphRes.json()) as { nodes: Array<{ type: string; x: number }>; edges: unknown[] };
    expect(graph.nodes.some((node) => node.type === "agent")).toBe(true);
    expect(graph.nodes.every((node) => Number.isFinite(node.x))).toBe(true);

    const eventsRes = await app.request(`/runs/${run.id}/events`);
    const eventsBody = (await eventsRes.json()) as { events: Array<{ seq: number; type: string }> };
    expect(eventsBody.events.some((event) => event.type === "workflow.started")).toBe(true);

    const snapRes = await app.request(`/runs/${run.id}/snapshot?seq=${eventsBody.events.at(-1)?.seq ?? 1}`);
    const snapshot = (await snapRes.json()) as { runStatus: string; completedSteps: unknown[] };
    expect(snapshot.completedSteps.length).toBeGreaterThan(0);

    const metrics = (await (await app.request("/metrics/overview")).json()) as { active: number; waitingHuman: number };
    expect(metrics.waitingHuman).toBeGreaterThanOrEqual(1);

    const stream = await app.request(`/runs/${run.id}/stream`);
    expect(stream.headers.get("content-type") ?? "").toContain("text/event-stream");
    await stream.body?.cancel();

    await engine.completeInteraction(run.id, "publish-tour", { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect(demoState.lookups).toBe(1);
    expect(demoState.published).toBe(1);

    const finishedTrace = (await (await app.request(`/runs/${run.id}/trace`)).json()) as {
      trace: { children: Array<{ name: string; type: string }> };
    };
    expect(finishedTrace.trace.children.some((child) => child.name === "writer" || child.type === "agent")).toBe(true);

    const forkRes = await app.request(`/runs/${run.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 2 }),
    });
    expect(forkRes.status).toBe(201);
    const fork = (await forkRes.json()) as { id: string; forkedFromRunId: string | null; forkedFromSeq: number | null };
    expect(fork.id).not.toBe(run.id);
    expect(fork.forkedFromRunId).toBe(run.id);
    expect(fork.forkedFromSeq).toBe(2);
  });
});
