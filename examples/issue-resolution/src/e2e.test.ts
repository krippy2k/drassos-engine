import { afterEach, describe, expect, it } from "vitest";
import { createDrassos } from "@drassos/engine";
import { createApi } from "@drassos/api";
import issueApp, { demoState, resetDemoState } from "./index.ts";

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

describe("github issue resolution demo", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    resetDemoState();
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("runs triage, research, coding, approval, and PR creation", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: issueApp,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("issue-resolution", {
      issue: 42,
      repository: "acme/widgets",
    });

    await waitFor(async () => (await engine.store.getRun(run.id))?.waitType === "human");
    const children = await engine.store.listChildren(run.id);
    expect(children.length).toBeGreaterThanOrEqual(1);
    const agentRuns = await engine.store.listAgentRuns(run.id);
    expect(agentRuns.length).toBeGreaterThanOrEqual(1);
    const tasks = await engine.store.listHumanTasks({ runId: run.id, status: "pending" });
    expect(tasks).toHaveLength(1);

    await engine.executor.completeHumanTask(tasks[0]!.id, { approved: true });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");

    const completed = await engine.store.getRun(run.id);
    expect(completed?.workflowVersion).toBe("1");
    expect(demoState.files["src/app.ts"]).toContain("return a + b");
    expect(demoState.testRuns).toBeGreaterThanOrEqual(2);
    expect(demoState.pullRequests).toBe(1);

    const history = await engine.store.listHistory(run.id);
    const types = history.map((event) => event.type);
    expect(types).toContain("agent.run.started");
    expect(types).toContain("model.completed");
    expect(types).toContain("tool.completed");
    expect(types).toContain("child.started");
    expect(types).toContain("child.completed");
    expect(types).toContain("human.completed");

    const grandchildBatches = await Promise.all(children.map((child) => engine.store.listChildren(child.id)));
    const allRuns = [run.id, ...children.map((child) => child.id), ...grandchildBatches.flat().map((child) => child.id)];
    const toolCalls = (await Promise.all(allRuns.map((id) => engine.store.listToolCalls({ runId: id })))).flat();
    expect(toolCalls.some((call) => call.source === "mcp" && call.name === "get_issue")).toBe(true);
    expect(toolCalls.some((call) => call.name === "run_tests")).toBe(true);
  });

  it("resumes after the worker is killed while waiting on a child and again at human approval", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: issueApp,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("issue-resolution", {
      issue: 42,
      repository: "acme/widgets",
    });

    await waitFor(async () => {
      const current = await engine.store.getRun(run.id);
      return current?.status === "WAITING" && current.waitType === "child";
    });
    const childrenBefore = await engine.store.listChildren(run.id);
    expect(childrenBefore.length).toBeGreaterThan(0);

    await engine.worker.stop();
    await engine.startWorker();

    await waitFor(async () => {
      const current = await engine.store.getRun(run.id);
      return current?.status === "WAITING" && current.waitType === "human";
    });

    const historyAfterRestart = await engine.store.listHistory(run.id);
    expect(historyAfterRestart.some((event) => event.type === "child.started")).toBe(true);

    await engine.worker.stop();
    await engine.startWorker();
    const tasks = await engine.store.listHumanTasks({ runId: run.id, status: "pending" });
    expect(tasks).toHaveLength(1);
    await engine.executor.completeHumanTask(tasks[0]!.id, { approved: true });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect(demoState.pullRequests).toBe(1);
  });

  it("exposes agent, child, and tool resources over HTTP", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: issueApp,
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const app = createApi({ drassos: engine });
    const created = await app.request("/workflows/issue-resolution/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { issue: 42, repository: "acme/widgets" } }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };
    await waitFor(async () => (await engine.store.getRun(run.id))?.waitType === "human");

    const agents = await app.request(`/runs/${run.id}/agents`);
    expect(agents.status).toBe(200);
    const agentBody = (await agents.json()) as { agents: Array<{ id: string }> };
    expect(agentBody.agents.length).toBeGreaterThan(0);

    const agentDetail = await app.request(`/agents/${agentBody.agents[0]!.id}`);
    expect(agentDetail.status).toBe(200);

    const children = await app.request(`/runs/${run.id}/children`);
    expect(children.status).toBe(200);
    const childBody = (await children.json()) as { children: unknown[] };
    expect(childBody.children.length).toBeGreaterThan(0);

    const detail = await app.request(`/runs/${run.id}`);
    const body = (await detail.json()) as { agentRuns: unknown[]; children: unknown[] };
    expect(body.agentRuns.length).toBeGreaterThan(0);
    expect(body.children.length).toBeGreaterThan(0);
  });
});
