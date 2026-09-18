import { defineApp, workflow, type ModelProvider, type ModelRequest, type ModelResponse } from "@drassos/engine";
import { z } from "zod";

export const demoState = {
  published: 0,
  research: 0,
  drafts: 0,
};

export function resetDemoState(): void {
  demoState.published = 0;
  demoState.research = 0;
  demoState.drafts = 0;
}

const researchSchema = z.object({
  findings: z.string(),
});

const reportSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export function createReportProvider(): ModelProvider {
  return {
    name: "report",
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const text = request.messages.map((message) => message.content ?? "").join("\n");
      const revise = text.match(/Revise the report using this feedback:\s*([\s\S]*)/i);
      if (revise) {
        const feedback = revise[1]?.trim() || "general improvements";
        return {
          output: {
            title: "Durable Human Review",
            body: `Revised: ${feedback} Agents draft, humans approve, then publish exactly once.`,
          },
        };
      }
      if (/Write a short report/i.test(text)) {
        return {
          output: {
            title: "Durable Human Review",
            body: "Agents can draft reports, then a human decides whether to publish.",
          },
        };
      }
      return {
        output: { findings: "Demand for durable HITL workflows is increasing." },
      };
    },
  };
}

export interface ReportInput {
  topic: string;
}

export const reportApproval = workflow<ReportInput, unknown>("report-approval", async (ctx) => {
  const research = (await ctx.agent("researcher", {
    model: "report:demo",
    prompt: `Research ${ctx.input.topic}`,
    output: researchSchema,
    input: ctx.input,
  })) as { findings: string };
  let feedback: string | undefined;
  let revision = 0;
  let report = { title: "", body: "" };

  while (true) {
    report = (await ctx.agent(`writer-${revision}`, {
      model: "report:demo",
      prompt: feedback
        ? `Revise the report using this feedback: ${feedback}`
        : `Write a short report from: ${research.findings}`,
      output: reportSchema,
      input: { research, feedback: feedback ?? null },
    })) as { title: string; body: string };

    const decision = await ctx.approval({
      id: revision === 0 ? "publish-report" : `publish-report-r${revision}`,
      title: "Publish generated report?",
      description: `${report.title}\n\n${report.body}`,
      metadata: { report, revision },
    });

    if (decision.outcome === "approved") {
      const published = await ctx.step("publish", async () => {
        demoState.published += 1;
        return { ok: true, title: report.title };
      });
      return { status: "published", report, published };
    }
    if (decision.outcome === "rejected") {
      return { status: "rejected", reason: decision.reason ?? "rejected", report };
    }
    if (decision.outcome === "timed_out") {
      return { status: "timed_out", report };
    }
    feedback = decision.feedback;
    revision += 1;
  }
});

export function createReportApp() {
  return defineApp({
    workflows: [reportApproval],
    models: { report: createReportProvider() },
  });
}

export default createReportApp();
