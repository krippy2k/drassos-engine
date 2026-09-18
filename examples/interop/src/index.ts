import {
  a2aAgent,
  defineAgent,
  defineApp,
  tool,
  workflow,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@drassos/engine";
import { mcpServer } from "@drassos/engine";
import { z } from "zod";

export const interopUrls = {
  mcp: process.env.DRASSOS_INTEROP_MCP_URL ?? "http://127.0.0.1:3981",
  a2a: process.env.DRASSOS_INTEROP_A2A_URL ?? "http://127.0.0.1:3982",
};

export function setInteropUrls(urls: { mcp?: string; a2a?: string }): void {
  if (urls.mcp) {
    interopUrls.mcp = urls.mcp;
  }
  if (urls.a2a) {
    interopUrls.a2a = urls.a2a;
  }
}

export const demoState = {
  lookups: 0,
  summaries: 0,
};

export function resetDemoState(): void {
  demoState.lookups = 0;
  demoState.summaries = 0;
}

export const lookupCustomer = tool({
  name: "lookup-customer",
  description: "Load a local customer record",
  input: z.object({ id: z.string() }),
  execute: async (input) => {
    demoState.lookups += 1;
    return { id: input.id, name: "Ada Lovelace", segment: "enterprise" };
  },
});

const market = mcpServer({
  name: "market",
  transport: {
    type: "http",
    url: () => interopUrls.mcp,
  },
});

const researcher = a2aAgent({
  name: "researcher",
  url: () => interopUrls.a2a,
});

const analyst = defineAgent({
  name: "analyst",
  instructions: "Summarize research for a human reviewer",
  model: "interop:demo",
});

export function createInteropProvider(): ModelProvider {
  return {
    name: "interop",
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const text = request.messages.map((message) => message.content ?? "").join("\n");
      return {
        output: {
          summary: `Analyst notes: ${text.slice(0, 180)}`,
        },
      };
    },
  };
}

export const summarizeInterop = workflow("summarize-interop", async (ctx) => {
  demoState.summaries += 1;
  return {
    status: "compiled",
    payload: ctx.input,
  };
});

export interface InteropInput {
  customerId?: string;
  market?: string;
}

export const interopDemo = workflow<InteropInput, unknown>("interop-demo", async (ctx) => {
  const customer = await ctx.tool(lookupCustomer).run({ id: ctx.input.customerId ?? "cust_1" });
  const marketReport = await ctx.tool(market.tool("get_market_report")).run({
    market: ctx.input.market ?? "semiconductors",
  });
  const localNotes = await ctx.agent(analyst).run({
    task: `Summarize ${(marketReport as { report?: string }).report ?? "the market"}`,
  });
  const remoteBrief = await ctx.agent(researcher).run({
    task: `Research ${ctx.input.market ?? "semiconductors"}`,
  });
  const decision = await ctx.approval({
    id: "publish-interop",
    title: "Publish interop brief",
    description: "Approve mixing local, MCP, and A2A results",
  });
  if (decision.outcome !== "approved") {
    return { status: "rejected", reason: decision.outcome === "rejected" ? decision.reason : decision.outcome };
  }
  return ctx.workflow.run(summarizeInterop, {
    customer,
    marketReport,
    localNotes,
    remoteBrief,
    decision,
  });
});

export const inboundResearch = workflow("inbound-research", async (ctx) => {
  const notes = await ctx.agent(analyst).run({ task: `Inbound ${(ctx.input as { topic?: string }).topic ?? "topic"}` });
  return { status: "done", notes };
});

export function createInteropApp() {
  return defineApp({
    workflows: [interopDemo, summarizeInterop, inboundResearch],
    agents: [analyst],
    tools: [lookupCustomer],
    models: {
      interop: createInteropProvider(),
    },
  });
}

export default createInteropApp();
