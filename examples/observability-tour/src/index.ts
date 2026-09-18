import { defineApp, tool, workflow, type ModelProvider, type ModelRequest, type ModelResponse } from "@drassos/engine";
import { z } from "zod";

export const demoState = {
  lookups: 0,
  summaries: 0,
  published: 0,
};

export function resetDemoState(): void {
  demoState.lookups = 0;
  demoState.summaries = 0;
  demoState.published = 0;
}

const researchSchema = z.object({
  findings: z.string(),
});

const briefSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export const lookupNotes = tool({
  name: "lookupNotes",
  description: "Look up research notes for a topic",
  input: z.object({ topic: z.string() }),
  execute: async ({ topic }) => {
    demoState.lookups += 1;
    return { topic, notes: `Durable history is the source of truth for ${topic}.` };
  },
});

export function createTourProvider(): ModelProvider {
  return {
    name: "tour",
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const text = request.messages.map((message) => message.content ?? "").join("\n");
      const hasToolResult = request.messages.some((message) => message.role === "tool");
      if (request.tools?.some((item) => item.name === "lookupNotes") && !hasToolResult) {
        const topic = text.match(/Research\s+(.+)/i)?.[1]?.trim() || "observability";
        return {
          toolCalls: [{ id: "lookup-1", name: "lookupNotes", arguments: { topic } }],
          usage: { inputTokens: 120, outputTokens: 40 },
          finishReason: "tool",
        };
      }
      if (/Write a brief/i.test(text)) {
        return {
          output: {
            title: "Observability Tour",
            body: "The researcher called a tool, a child summarized the notes, a human approved, then the writer finished.",
          },
          usage: { inputTokens: 80, outputTokens: 60 },
          finishReason: "stop",
        };
      }
      return {
        output: { findings: "Agents, tools, children, and humans all appear in one execution graph." },
        usage: { inputTokens: 90, outputTokens: 50 },
        finishReason: "stop",
      };
    },
  };
}

export interface TourInput {
  topic: string;
  secretToken?: string;
}

export const observabilitySummary = workflow<{ findings: string }, { summary: string }>(
  "observability-summary",
  async (ctx) => {
    demoState.summaries += 1;
    const saved = await ctx.step("save-summary", async () => ({
      summary: `Child summary: ${ctx.input.findings}`,
    }));
    return saved;
  },
);

export const observabilityTour = workflow<TourInput, unknown>("observability-tour", async (ctx) => {
  const research = (await ctx.agent("researcher", {
    model: "tour:demo",
    prompt: `Research ${ctx.input.topic}`,
    tools: ["lookupNotes"],
    output: researchSchema,
    input: ctx.input,
    maxTurns: 4,
  })) as { findings: string };

  const child = (await ctx.workflow("observability-summary", { findings: research.findings })) as {
    summary: string;
  };

  const decision = await ctx.approval({
    id: "publish-tour",
    title: "Publish observability tour?",
    description: child.summary,
    metadata: { research, child },
  });

  if (decision.outcome !== "approved") {
    return { status: "rejected", reason: decision.outcome, research, child };
  }

  const writeup = (await ctx.agent("writer", {
    model: "tour:demo",
    prompt: `Write a brief from ${child.summary}`,
    output: briefSchema,
    input: { research, child },
  })) as { title: string; body: string };

  const published = await ctx.step("publish", async () => {
    demoState.published += 1;
    return { ok: true, title: writeup.title };
  });

  return { status: "published", research, child, writeup, published };
});

export function createTourApp() {
  return defineApp({
    workflows: [observabilityTour, observabilitySummary],
    tools: [lookupNotes],
    models: { tour: createTourProvider() },
  });
}

export default createTourApp();
