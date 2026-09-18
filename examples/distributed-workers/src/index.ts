import { defineApp, workflow, type ActivityContext, type DrassosWorker } from "@drassos/engine";

export const demoState = {
  leads: 0,
  research: 0,
  longStarts: 0,
  workers: new Set<string>(),
  failOnce: false,
  blockLong: null as Promise<void> | null,
};

export function resetDemoState(): void {
  demoState.leads = 0;
  demoState.research = 0;
  demoState.longStarts = 0;
  demoState.workers.clear();
  demoState.failOnce = false;
  demoState.blockLong = null;
}

export const distributedResearch = workflow("distributed-research", async (ctx) => {
  const lead = await ctx.activity(
    "process-lead",
    { company: (ctx.input as { company?: string }).company ?? "Northwind" },
    { queue: "tools" },
  );
  const research = await ctx.activity("research", lead, { queue: "agents" });
  const analysis = await ctx.activity("long-analyze", research, {
    queue: "agents",
    retry: { maxAttempts: 3, backoff: "fixed", initialDelay: "50ms" },
  });
  return { lead, research, analysis };
});

export function registerWorker(worker: Pick<DrassosWorker, "activity" | "agent">): void {
  worker.activity("process-lead", async (ctx: ActivityContext, input: unknown) => {
    demoState.leads += 1;
    demoState.workers.add(ctx.taskId ? String(process.pid) : "local");
    const company = (input as { company?: string }).company ?? "unknown";
    return { company, leadId: `lead_${company.toLowerCase()}` };
  });

  worker.activity("research", async (ctx: ActivityContext, input: unknown) => {
    demoState.research += 1;
    await ctx.heartbeat({ progress: 0.5, message: "Gathering sources" });
    const lead = input as { company?: string; leadId?: string };
    return { leadId: lead.leadId, brief: `Research brief for ${lead.company}` };
  });

  worker.activity("long-analyze", async (ctx: ActivityContext, input: unknown) => {
    demoState.longStarts += 1;
    if (demoState.failOnce) {
      demoState.failOnce = false;
      throw new Error("analyzer overloaded");
    }
    if (demoState.blockLong) {
      await Promise.race([
        demoState.blockLong,
        new Promise((_, reject) => {
          ctx.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
    }
    const brief = (input as { brief?: string }).brief ?? "brief";
    await ctx.heartbeat({ progress: 0.8, message: "Scoring" });
    return { score: 91, brief, idempotencyKey: ctx.idempotencyKey };
  });
}

export function createDistributedApp() {
  return defineApp({ workflows: [distributedResearch] });
}

export default createDistributedApp();
