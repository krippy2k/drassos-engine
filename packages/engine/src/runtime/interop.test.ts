import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDrassos } from "./create-drassos.ts";
import { workflow } from "../sdk/workflow.ts";
import { defineAgent, defineApp } from "../sdk/app.ts";
import { tool } from "../sdk/agent.ts";
import { mcpServer } from "./mcp.ts";
import { createMcpServer } from "./mcp-gateway.ts";
import { a2aAgent, createA2AServer, InMemoryA2AService, listenA2AService } from "./a2a.ts";
import { secretRef } from "../capabilities/auth.ts";
import { McpAuthError, McpRemoteError, McpUnknownToolError, TimeoutError } from "../core/errors.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("interop adapters", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it("discovers and invokes an MCP tool from a workflow", async () => {
    const gateway = createMcpServer({ name: "market" });
    gateway.tool("get_market_report", {
      tool: tool({
        name: "get_market_report",
        description: "Market report",
        input: z.object({ market: z.string() }),
        execute: async (input) => ({ report: `Outlook for ${input.market}` }),
      }),
    });
    const listening = await gateway.listen();
    servers.push(gateway);
    const market = mcpServer({
      name: "market",
      transport: { type: "http", url: listening.url },
    });
    const discovered = await market.tools();
    expect(discovered.map((item) => item.name)).toContain("get_market_report");
    const demo = workflow("mcp-client", async (ctx) => {
      return ctx.tool(market.tool("get_market_report")).run({ market: "chips" });
    });
    const engine = await createDrassos({ inMemory: true, workflows: [demo], pollMs: 20, logLevel: "silent" });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("mcp-client", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ report: "Outlook for chips" });
    const ops = await engine.store.listRemoteOperations(run.id);
    expect(ops[0]?.provider).toBe("mcp");
    expect(JSON.stringify(ops)).not.toMatch(/Bearer |secret/i);
  });

  it("maps MCP unknown tools, remote failures, timeouts, and auth errors", async () => {
    const gateway = createMcpServer({
      name: "secured",
      auth: (headers) => {
        if (headers.authorization !== "Bearer test-token") {
          throw new McpAuthError("denied");
        }
      },
    });
    gateway.tool("slow", {
      tool: tool({
        name: "slow",
        description: "slow",
        input: z.object({}).optional(),
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { ok: true };
        },
      }),
    });
    gateway.tool("boom", {
      tool: tool({
        name: "boom",
        description: "boom",
        input: z.object({}).optional(),
        execute: async () => {
          throw new Error("remote exploded");
        },
      }),
    });
    const listening = await gateway.listen();
    servers.push(gateway);
    process.env.MCP_TEST_TOKEN = "Bearer test-token";
    const authed = mcpServer({
      name: "secured",
      transport: { type: "http", url: listening.url },
      auth: secretRef("MCP_TEST_TOKEN"),
      timeout: 80,
    });
    const missing = workflow("mcp-missing", async (ctx) => ctx.tool(authed.tool("nope")).run({}));
    const boom = workflow("mcp-boom", async (ctx) => ctx.tool(authed.tool("boom")).run({}));
    const slow = workflow("mcp-slow", async (ctx) => ctx.tool(authed.tool("slow")).run({}));
    const engine = await createDrassos({
      inMemory: true,
      workflows: [missing, boom, slow],
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();

    const unknownRun = await engine.executor.startRun("mcp-missing", {});
    await waitFor(async () => (await engine.store.getRun(unknownRun.id))?.status === "FAILED");
    expect((await engine.store.getRun(unknownRun.id))?.error?.name).toBe(McpUnknownToolError.name);

    const boomRun = await engine.executor.startRun("mcp-boom", {});
    await waitFor(async () => (await engine.store.getRun(boomRun.id))?.status === "FAILED");
    expect((await engine.store.getRun(boomRun.id))?.error?.name).toBe(McpRemoteError.name);

    const slowRun = await engine.executor.startRun("mcp-slow", {});
    await waitFor(async () => (await engine.store.getRun(slowRun.id))?.status === "FAILED");
    expect((await engine.store.getRun(slowRun.id))?.error?.name).toBe(TimeoutError.name);

    const unauth = mcpServer({
      name: "secured-bad",
      transport: { type: "http", url: listening.url },
    });
    const denied = workflow("mcp-denied", async (ctx) => ctx.tool(unauth.tool("boom")).run({}));
    engine.registry.register(denied);
    const deniedRun = await engine.executor.startRun("mcp-denied", {});
    await waitFor(async () => (await engine.store.getRun(deniedRun.id))?.status === "FAILED");
    expect((await engine.store.getRun(deniedRun.id))?.error?.name).toBe(McpAuthError.name);
  });

  it("exposes Drassos tools and workflows over MCP", async () => {
    const lookup = tool({
      name: "lookup-customer",
      description: "lookup",
      input: z.object({ id: z.string() }),
      execute: async (input) => ({ id: input.id, name: "Ada" }),
    });
    const child = workflow("exposed-child", async (ctx) => ({ echoed: (ctx.input as { n: number }).n }));
    const engine = await createDrassos({
      inMemory: true,
      app: defineApp({ workflows: [child], tools: [lookup] }),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const server = createMcpServer({ name: "drassos", drassos: engine });
    server.tool("lookup-customer", { tool: lookup });
    server.tool("exposed-child", { workflow: child });
    const listening = await server.listen();
    servers.push(server);
    const client = mcpServer({ name: "drassos", transport: { type: "http", url: listening.url } });
    const tools = await client.tools();
    expect(tools.map((item) => item.name).sort()).toEqual(["exposed-child", "lookup-customer"]);
    const consumer = workflow("consume-exposed", async (ctx) => {
      const local = await ctx.tool(client.tool("lookup-customer")).run({ id: "c1" });
      const nested = await ctx.tool(client.tool("exposed-child")).run({ n: 7 });
      return { local, nested };
    });
    engine.registry.register(consumer);
    const run = await engine.executor.startRun("consume-exposed", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({
      local: { id: "c1", name: "Ada" },
      nested: { status: "completed", output: { echoed: 7 } },
    });
  });

  it("invokes an A2A agent, recovers after restart, and does not duplicate work", async () => {
    const service = new InMemoryA2AService({
      name: "researcher",
      delayMs: 250,
      handler: (input) => ({ brief: `researched ${(input as { task?: string }).task}` }),
    });
    const remote = await listenA2AService(service);
    servers.push(remote);
    const card = (await (await fetch(`${remote.url}/.well-known/agent-card.json`)).json()) as { name: string };
    expect(card.name).toBe("researcher");
    const researcher = a2aAgent({ name: "researcher", url: remote.url });
    const demo = workflow("a2a-client", async (ctx) => ctx.agent(researcher).run({ task: "semiconductors" }));
    const engine = await createDrassos({ inMemory: true, workflows: [demo], pollMs: 20, logLevel: "silent" });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("a2a-client", {});
    await waitFor(async () => {
      const ops = await engine.store.listRemoteOperations(run.id);
      return Boolean(ops.some((op) => op.remoteTaskId && (op.status === "WORKING" || op.status === "SENDING")));
    });
    expect(service.sendCount).toBe(1);
    await engine.worker.stop();
    await engine.startWorker();
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect(service.sendCount).toBe(1);
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ brief: "researched semiconductors" });
    const recovered = (await engine.store.listHistory(run.id)).some((event) => event.type === "remote.task.recovered");
    expect(recovered).toBe(true);
  });

  it("cancels an A2A task when the workflow is cancelled", async () => {
    const service = new InMemoryA2AService({
      name: "slow-agent",
      delayMs: 2_000,
      handler: () => ({ ok: true }),
    });
    const remote = await listenA2AService(service);
    servers.push(remote);
    const agent = a2aAgent({ name: "slow-agent", url: remote.url });
    const demo = workflow("a2a-cancel", async (ctx) => ctx.agent(agent).run({ task: "wait" }));
    const engine = await createDrassos({ inMemory: true, workflows: [demo], pollMs: 20, logLevel: "silent" });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("a2a-cancel", {});
    await waitFor(async () => (await engine.store.listRemoteOperations(run.id)).some((op) => op.remoteTaskId));
    await engine.cancelExecution(run.id, "stop");
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "CANCELLED");
    expect(service.cancelCount).toBeGreaterThanOrEqual(1);
  });

  it("exposes a Drassos agent over A2A", async () => {
    const hosted = defineAgent({
      name: "writer",
      instructions: "Write a brief",
      model: "scripted:demo",
    });
    const engine = await createDrassos({
      inMemory: true,
      app: defineApp({
        workflows: [],
        agents: [hosted],
        models: {
          scripted: {
            name: "scripted",
            async generate() {
              return { output: { body: "hosted agent result" } };
            },
          },
        },
      }),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const gateway = createA2AServer({ name: "drassos", drassos: engine });
    gateway.agent(hosted);
    const listening = await gateway.listen();
    servers.push(gateway);
    const researcher = a2aAgent({ name: "writer", url: listening.url });
    const consumer = workflow("call-hosted", async (ctx) => ctx.agent(researcher).run({ task: "write" }));
    engine.registry.register(consumer);
    const run = await engine.executor.startRun("call-hosted", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED", 12_000);
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ body: "hosted agent result" });
  });
});
