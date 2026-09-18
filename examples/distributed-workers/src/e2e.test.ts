import { afterEach, describe, expect, it } from "vitest";
import { createApi, listenApi } from "@drassos/api";
import { createDrassos, DrassosWorker } from "@drassos/engine";
import {
  createDistributedApp,
  demoState,
  registerWorker,
  resetDemoState,
} from "./index.ts";

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

describe("distributed workers demo", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  const servers: Array<{ close: () => Promise<void> }> = [];
  const workers: Array<{ stop: (opts?: { drain?: boolean }) => Promise<void> }> = [];

  afterEach(async () => {
    resetDemoState();
    while (workers.length > 0) {
      await workers.pop()?.stop({ drain: false });
    }
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("runs activities across HTTP workers and recovers after a worker crash", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createDistributedApp(),
      controlPlane: true,
      pollMs: 20,
      leaseMs: 400,
      logLevel: "silent",
      workerToken: "demo-token",
    });
    engines.push(engine);
    await engine.startWorker();
    const api = createApi({ drassos: engine });
    const server = await listenApi(api, { port: 0 });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const tools = new DrassosWorker({
      server: base,
      token: "demo-token",
      queues: ["tools"],
      concurrency: 2,
      workerId: "worker-tools",
      pollMs: 40,
      leaseMs: 400,
      logger: engine.logger,
    });
    const agentsA = new DrassosWorker({
      server: base,
      token: "demo-token",
      queues: ["agents"],
      concurrency: 2,
      workerId: "worker-agents-a",
      pollMs: 40,
      leaseMs: 400,
      logger: engine.logger,
    });
    const agentsB = new DrassosWorker({
      server: base,
      token: "demo-token",
      queues: ["agents"],
      concurrency: 2,
      workerId: "worker-agents-b",
      pollMs: 40,
      leaseMs: 400,
      logger: engine.logger,
    });
    registerWorker(tools);
    registerWorker(agentsA);
    registerWorker(agentsB);

    let release: () => void = () => undefined;
    demoState.blockLong = new Promise<void>((resolve) => {
      release = resolve;
    });

    await tools.start();
    await agentsA.start();
    workers.push(tools, agentsA, agentsB);

    const run = await engine.executor.startRun("distributed-research", { company: "Contoso" });
    await waitFor(async () => demoState.longStarts >= 1);

    await agentsA.stop({ drain: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await agentsB.start();
    await engine.store.recoverExpiredLeases();
    release();

    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED", 10_000);
    const finished = await engine.store.getRun(run.id);
    expect(finished?.output).toMatchObject({
      analysis: { score: 91 },
    });
    expect(demoState.leads).toBeGreaterThanOrEqual(1);
    expect(demoState.longStarts).toBeGreaterThanOrEqual(2);

    const queues = await engine.store.getQueueMetrics();
    expect(queues.some((item) => item.queue === "agents" && item.completed >= 1)).toBe(true);
    const listed = await engine.store.listWorkers();
    expect(listed.some((item) => item.id === "worker-tools")).toBe(true);
  });

  it("rejects unauthenticated workers and incompatible protocol versions", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createDistributedApp(),
      controlPlane: true,
      pollMs: 20,
      logLevel: "silent",
      workerToken: "secret",
    });
    engines.push(engine);
    const api = createApi({ drassos: engine });
    const server = await listenApi(api, { port: 0 });
    servers.push(server);
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/worker/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "w", queues: ["tools"], concurrency: 1 }),
    });
    expect(unauthorized.status).toBe(401);
    const badProtocol = await fetch(`http://127.0.0.1:${server.port}/worker/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({
        protocolVersion: "99",
        workerId: "w",
        queues: ["tools"],
        concurrency: 1,
      }),
    });
    expect(badProtocol.status).toBe(400);
  });
});
