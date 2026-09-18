import {
  defineAgent,
  defineApp,
  workflow,
  type DelegationPlan,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@drassos/engine";
import { z } from "zod";

export const demoState = {
  plans: 0,
  specialistRuns: 0,
  published: 0,
};

export function resetDemoState(): void {
  demoState.plans = 0;
  demoState.specialistRuns = 0;
  demoState.published = 0;
}

const planSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["agent", "workflow"]),
      target: z.string(),
      input: z.record(z.unknown()).optional(),
      dependsOn: z.array(z.string()).optional(),
    }),
  ),
});

const findingSchema = z.object({
  agent: z.string(),
  summary: z.string(),
});

const reportSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export function createResearchProvider(): ModelProvider {
  return {
    name: "research",
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const text = request.messages.map((message) => message.content ?? "").join("\n");
      if (/plan research tasks/i.test(text)) {
        const topic = text.match(/topic:\s*(.*)/i)?.[1]?.trim() || "durable orchestration";
        return {
          output: {
            tasks: [
              { id: "web", type: "agent", target: "web-researcher", input: { topic, lens: "web" } },
              { id: "technical", type: "agent", target: "technical-reviewer", input: { topic, lens: "technical" } },
              { id: "critic", type: "agent", target: "critic", input: { topic, lens: "critique" } },
            ],
          },
        };
      }
      if (/Revise the research brief/i.test(text)) {
        const feedback = text.match(/feedback:\s*([\s\S]*)/i)?.[1]?.trim() || "general improvements";
        return {
          output: {
            title: "Durable Multi-Agent Research",
            body: `Revised: ${feedback} Specialists researched in parallel, then a writer synthesized the brief.`,
          },
        };
      }
      if (/Write a research brief/i.test(text)) {
        return {
          output: {
            title: "Durable Multi-Agent Research",
            body: "Web, technical, and critic specialists ran in parallel. The writer synthesized their findings into one brief.",
          },
        };
      }
      const lens = text.match(/lens:\s*(\w+)/i)?.[1] ?? "general";
      return {
        output: {
          agent: lens,
          summary: `${lens} findings on durable hierarchical agent orchestration.`,
        },
      };
    },
  };
}

const planner = defineAgent({
  name: "planner",
  instructions: "Plan research tasks",
  model: "research:demo",
  output: planSchema,
});

const webResearcher = defineAgent({
  name: "web-researcher",
  instructions: "Research the public web angle",
  model: "research:demo",
  output: findingSchema,
});

const technicalReviewer = defineAgent({
  name: "technical-reviewer",
  instructions: "Review technical feasibility",
  model: "research:demo",
  output: findingSchema,
});

const critic = defineAgent({
  name: "critic",
  instructions: "Critique the research framing",
  model: "research:demo",
  output: findingSchema,
});

const writer = defineAgent({
  name: "writer",
  instructions: "Write a research brief",
  model: "research:demo",
  output: reportSchema,
});

export interface ResearchInput {
  topic: string;
}

export const multiAgentResearch = workflow<ResearchInput, unknown>("multi-agent-research", async (ctx) => {
  const plan = (await ctx.agent("planner", {
    task: `Plan research tasks for topic: ${ctx.input.topic}`,
    input: ctx.input,
  })) as DelegationPlan;
  await ctx.step("count-plan", async () => {
    demoState.plans += 1;
    return demoState.plans;
  });

  const specialistResults = await ctx.executePlan(plan);

  await ctx.step("count-specialists", async () => {
    demoState.specialistRuns += Object.keys(specialistResults).length;
    return demoState.specialistRuns;
  });

  let feedback: string | undefined;
  let revision = 0;
  let report = { title: "", body: "" };

  while (true) {
    report = (await ctx.agent("writer", {
      task: feedback
        ? `Revise the research brief using this feedback: ${feedback}`
        : `Write a research brief from specialist results: ${JSON.stringify(specialistResults)}`,
      input: { specialistResults, feedback: feedback ?? null },
    })) as { title: string; body: string };

    const decision = await ctx.approval({
      id: revision === 0 ? "publish-research" : `publish-research-r${revision}`,
      title: "Publish multi-agent research brief?",
      description: `${report.title}\n\n${report.body}`,
      metadata: { report, revision, specialistResults },
    });

    if (decision.outcome === "approved") {
      const published = await ctx.step("publish", async () => {
        demoState.published += 1;
        return { ok: true, title: report.title };
      });
      return { status: "published", report, specialistResults, published };
    }
    if (decision.outcome === "rejected") {
      return { status: "rejected", reason: decision.reason ?? "rejected", report, specialistResults };
    }
    if (decision.outcome === "timed_out") {
      return { status: "timed_out", report, specialistResults };
    }
    feedback = decision.feedback;
    revision += 1;
  }
});

export const researchTopic = workflow("research-topic", async (ctx) => {
  return ctx.agent("web-researcher", ctx.input);
});

export function createResearchApp() {
  return defineApp({
    workflows: [multiAgentResearch, researchTopic],
    agents: [planner, webResearcher, technicalReviewer, critic, writer],
    models: { research: createResearchProvider() },
  });
}

export default createResearchApp();
