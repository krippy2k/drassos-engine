import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  a2aAgent,
  createA2AServer,
  createDrassos,
  createMcpServer,
  InMemoryA2AService,
  listenA2AService,
  mcpServer,
  tool,
  workflow,
} from "@drassos/engine";
import { createInteropApp, demoState, lookupCustomer, resetDemoState, setInteropUrls } from "./index.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("interop demo", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    resetDemoState();
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it("runs local tool, MCP tool, local agent, A2A agent, HITL, and a child workflow", async () => {
    const market = createMcpServer({ name: "market" });
    market.tool("get_market_report", {
      tool: tool({
        name: "get_market_report",
        description: "External market report",
        input: z.object({ market: z.string() }),
        execute: async (input) => ({ report: `Demand for ${input.market} is rising.` }),
      }),
    });
    const marketUrl = await market.listen();
    servers.push(market);
    const research = new InMemoryA2AService({
      name: "researcher",
      delayMs: 80,
      handler: (input) => ({ brief: `External brief for ${(input as { task?: string }).task}` }),
    });
    const a2a = await listenA2AService(research);
    servers.push(a2a);
    setInteropUrls({ mcp: marketUrl.url, a2a: a2a.url });

    const engine = await createDrassos({
      inMemory: true,
      app: createInteropApp(),
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();

    const inboundMcp = createMcpServer({ name: "drassos", drassos: engine });
    inboundMcp.tool("lookup-customer", { tool: lookupCustomer });
    inboundMcp.tool("inbound-research", { workflow: engine.registry.get("inbound-research") });
    const inboundMcpUrl = await inboundMcp.listen();
    servers.push(inboundMcp);
    const inboundA2a = createA2AServer({ name: "drassos-agents", drassos: engine });
    inboundA2a.agent(engine.agents.get("analyst"));
    const inboundA2aUrl = await inboundA2a.listen();
    servers.push(inboundA2a);

    const run = await engine.executor.startRun("interop-demo", {
      customerId: "cust_9",
      market: "semiconductors",
    });
    await waitFor(async () => (await engine.getPendingInteractions(run.id)).length > 0);
    const pending = await engine.getPendingInteractions(run.id);
    expect(pending[0]?.title).toBe("Publish interop brief");
    await engine.completeInteraction(run.id, pending[0]!.interactionId, { outcome: "approved" });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const output = (await engine.store.getRun(run.id))?.output as {
      status?: string;
      payload?: { remoteBrief?: { brief?: string } };
    };
    expect(output.status).toBe("compiled");
    expect(output.payload?.remoteBrief?.brief).toMatch(/semiconductors/);
    expect(demoState.lookups).toBe(1);
    expect(demoState.summaries).toBe(1);
    expect(research.sendCount).toBe(1);

    const client = mcpServer({ name: "inbound", transport: { type: "http", url: inboundMcpUrl.url } });
    const listed = await client.tools();
    expect(listed.map((item) => item.name)).toEqual(expect.arrayContaining(["lookup-customer", "inbound-research"]));
    const inboundFlow = workflow("call-inbound-mcp", async (ctx) =>
      ctx.tool(client.tool("inbound-research")).run({ topic: "MCP inbound" }),
    );
    engine.registry.register(inboundFlow);
    const inboundRun = await engine.executor.startRun("call-inbound-mcp", {});
    await waitFor(async () => (await engine.store.getRun(inboundRun.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(inboundRun.id))?.output).toMatchObject({ status: "completed" });

    const hosted = a2aAgent({ name: "analyst", url: inboundA2aUrl.url });
    const hostedFlow = await createDrassos({
      inMemory: true,
      workflows: [workflow("call-hosted-analyst", async (ctx) => ctx.agent(hosted).run({ task: "A2A inbound" }))],
      pollMs: 20,
      logLevel: "silent",
    });
    engines.push(hostedFlow);
    await hostedFlow.startWorker();
    const hostedRun = await hostedFlow.executor.startRun("call-hosted-analyst", {});
    await waitFor(async () => (await hostedFlow.store.getRun(hostedRun.id))?.status === "COMPLETED");
    expect((await hostedFlow.store.getRun(hostedRun.id))?.output).toMatchObject({ summary: expect.any(String) });
  });
});
