import { afterEach, describe, expect, it } from "vitest";
import {
  CircularDependencyError,
  createDrassos,
  defineAgent,
  defineApp,
  UnknownAgentError,
  UnknownWorkflowError,
  workflow,
} from "../index.ts";
import { ScriptedModelProvider } from "../agents/providers.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

describe("v0.5 orchestration", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => {
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("assigns parent, root, and depth for awaited named child workflows", async () => {
    const child = workflow("child-work", async (ctx) => ({ from: ctx.input }));
    const parent = workflow("parent-work", async (ctx) => ctx.workflow("child-work", ctx.input));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [child, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("parent-work", { n: 1 });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const children = await engine.store.listChildren(run.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.parentRunId).toBe(run.id);
    expect(children[0]?.rootRunId).toBe(run.id);
    expect(children[0]?.childDepth).toBe(1);
    const execution = await engine.getExecution(children[0]!.id);
    expect(execution?.parentExecutionId).toBe(run.id);
    expect(execution?.rootExecutionId).toBe(run.id);
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ from: { n: 1 } });
  });

  it("starts a detached child and later awaits the same execution id", async () => {
    const child = workflow("slow-child", async (ctx) => {
      await ctx.sleep("20ms");
      return { ok: true, input: ctx.input };
    });
    const parent = workflow("detached-parent", async (ctx) => {
      const handle = await ctx.startWorkflow("slow-child", { x: 2 }, { cancellation: "detach" });
      const firstId = handle.executionId;
      const result = await handle.result();
      return { firstId, result, again: handle.executionId };
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 15,
      workflows: [child, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("detached-parent", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const output = (await engine.store.getRun(run.id))?.output as { firstId: string; again: string };
    expect(output.firstId).toBe(output.again);
    const childRun = await engine.store.getRun(output.firstId);
    expect(childRun?.cancelOnParentCancel).toBe(false);
    expect(childRun?.status).toBe("COMPLETED");
  });

  it("keeps nested child workflows on the same root", async () => {
    const leaf = workflow("leaf", async () => ({ leaf: true }));
    const mid = workflow("mid", async (ctx) => ({ mid: await ctx.workflow("leaf", {}) }));
    const root = workflow("root", async (ctx) => ctx.workflow("mid", {}));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [leaf, mid, root],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("root", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const tree = await engine.getExecutionTree(run.id);
    expect(tree.children[0]?.name).toBe("mid");
    expect(tree.children[0]?.children[0]?.name).toBe("leaf");
    expect(tree.children[0]?.children[0]?.children).toEqual([]);
    const leafRun = (await engine.store.listChildren(tree.children[0]!.executionId))[0];
    expect(leafRun?.rootRunId).toBe(run.id);
    expect(leafRun?.childDepth).toBe(2);
  });

  it("records workflow-to-agent executions in the tree", async () => {
    const researcher = defineAgent({
      name: "researcher",
      instructions: "research",
      model: "scripted:demo",
    });
    const parent = workflow("with-agent", async (ctx) => ctx.agent("researcher", { topic: "x" }));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      app: defineApp({
        workflows: [parent],
        agents: [researcher],
        models: { scripted: new ScriptedModelProvider([{ output: { ok: true } }]) },
      }),
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("with-agent", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const tree = await engine.getExecutionTree(run.id);
    expect(tree.children.some((child) => child.type === "agent" && child.name === "researcher")).toBe(true);
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ ok: true });
  });

  it("delegates agent-to-agent through the runtime", async () => {
    const reviewer = defineAgent({
      name: "reviewer",
      instructions: "review",
      model: "scripted:demo",
    });
    const planner = defineAgent({
      name: "lead",
      instructions: "lead",
      model: "scripted:demo",
      delegateTo: ["reviewer"],
    });
    const parent = workflow("handoff", async (ctx) => ctx.agent("lead", { code: "x" }));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      app: defineApp({
        workflows: [parent],
        agents: [planner, reviewer],
        models: {
          scripted: new ScriptedModelProvider([
            {
              output: null,
              toolCalls: [{ id: "d1", name: "delegate", arguments: { agent: "reviewer", input: { code: "x" } } }],
            },
            { output: { reviewed: true } },
            { output: { done: true } },
          ]),
        },
      }),
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("handoff", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const agents = await engine.store.listAgentRuns(run.id);
    expect(agents.some((item) => item.agentName === "reviewer")).toBe(true);
    expect(agents.some((item) => item.parentAgentRunId)).toBe(true);
    const tree = await engine.getExecutionTree(run.id);
    const lead = tree.children.find((child) => child.name === "lead");
    expect(lead?.children.some((child) => child.name === "reviewer")).toBe(true);
  });

  it("fans out and fans in durably with concurrency limits", async () => {
    const child = workflow("item", async (ctx) => {
      await ctx.sleep("15ms");
      return ctx.input;
    });
    const parent = workflow("fan", async (ctx) =>
      ctx.map([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], (item) => ctx.workflow("item", item), { concurrency: 2 }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 10,
      workflows: [child, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("fan", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(await engine.store.listChildren(run.id)).toHaveLength(4);
  });

  it("returns child errors when onFailure is return-error", async () => {
    const boom = workflow("boom", async () => {
      throw new Error("specialist failed");
    });
    const parent = workflow("tolerate", async (ctx) => ctx.workflow("boom", {}, { onFailure: "return-error" }));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [boom, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("tolerate", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ ok: false });
  });

  it("fails the parent by default when a named child fails", async () => {
    const boom = workflow("boom-default", async () => {
      throw new Error("nope");
    });
    const parent = workflow("strict", async (ctx) => ctx.workflow("boom-default", {}));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [boom, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("strict", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "FAILED");
    expect((await engine.store.getRun(run.id))?.error?.name).toBe("ChildExecutionFailedError");
  });

  it("does not cancel detached children when the parent is cancelled", async () => {
    const child = workflow("linger", async (ctx) => {
      await ctx.sleep("2s");
      return { survived: true };
    });
    const parent = workflow("canceller", async (ctx) => {
      await ctx.startWorkflow("linger", {}, { cancellation: "detach" });
      await ctx.sleep("2s");
      return { parent: true };
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 15,
      workflows: [child, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("canceller", {});
    await waitFor(async () => (await engine.store.listChildren(run.id)).length === 1);
    await engine.cancelExecution(run.id, "stop parent");
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "CANCELLED");
    const childRun = (await engine.store.listChildren(run.id))[0];
    expect(childRun?.cancelOnParentCancel).toBe(false);
    expect(childRun?.status).not.toBe("CANCELLED");
  });

  it("times out a child workflow and fails the parent", async () => {
    const child = workflow("sleepy", async (ctx) => {
      await ctx.sleep("5s");
      return { late: true };
    });
    const parent = workflow("impatient", async (ctx) => ctx.workflow("sleepy", {}, { timeout: "30ms" }));
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 10,
      workflows: [child, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("impatient", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "FAILED", 6_000);
    const childRun = (await engine.store.listChildren(run.id))[0];
    expect(childRun?.status).toBe("FAILED");
  });

  it("rejects unknown agents/workflows and invalid plans", async () => {
    const parent = workflow("bad-plan", async (ctx) => {
      await expect(ctx.workflow("missing", {})).rejects.toBeInstanceOf(UnknownWorkflowError);
      await expect(ctx.agent("ghost", { q: 1 })).rejects.toBeInstanceOf(UnknownAgentError);
      await expect(
        ctx.executePlan({
          tasks: [
            { id: "a", type: "agent", target: "writer", dependsOn: ["b"] },
            { id: "b", type: "agent", target: "writer", dependsOn: ["a"] },
          ],
        }),
      ).rejects.toBeInstanceOf(CircularDependencyError);
      return { ok: true };
    });
    const writer = defineAgent({ name: "writer", instructions: "w", model: "scripted:demo" });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      app: defineApp({
        workflows: [parent],
        agents: [writer],
        models: { scripted: new ScriptedModelProvider([{ output: {} }]) },
      }),
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("bad-plan", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
  });

  it("enforces orchestration limits", async () => {
    const child = workflow("unit", async () => ({ ok: true }));
    const parent = workflow("too-many", async (ctx) => {
      await ctx.workflow("unit", { i: 1 });
      await ctx.workflow("unit", { i: 2 });
      return { ok: true };
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [child, parent],
      orchestrationLimits: { maxChildrenPerExecution: 1, maxDepth: 8, maxExecutionsPerTree: 128, maxConcurrentChildren: 8 },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("too-many", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "FAILED");
    expect((await engine.store.getRun(run.id))?.error?.name).toBe("ExecutionLimitExceededError");
  });

  it("does not recreate completed children after replay", async () => {
    const child = workflow("once", async (ctx) => ({ v: ctx.input }));
    const parent = workflow("replay-parent", async (ctx) => {
      const first = await ctx.workflow("once", { a: 1 });
      await ctx.sleep("30ms");
      const second = await ctx.workflow("once", { a: 1 });
      return { first, second };
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 10,
      workflows: [child, parent],
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("replay-parent", {});
    await waitFor(async () => (await engine.store.listChildren(run.id)).length >= 1);
    const idsBefore = (await engine.store.listChildren(run.id)).map((item) => item.id);
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const idsAfter = (await engine.store.listChildren(run.id)).map((item) => item.id);
    expect(idsAfter[0]).toBe(idsBefore[0]);
    expect(idsAfter).toHaveLength(2);
  });

  it("executes a planner-generated plan without duplicating children", async () => {
    const specialist = defineAgent({
      name: "specialist",
      instructions: "work",
      model: "scripted:demo",
    });
    const parent = workflow("planned", async (ctx) =>
      ctx.executePlan({
        tasks: [
          { id: "a", type: "agent", target: "specialist", input: { k: "a" } },
          { id: "b", type: "agent", target: "specialist", input: { k: "b" } },
        ],
      }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      app: defineApp({
        workflows: [parent],
        agents: [specialist],
        models: {
          scripted: {
            name: "scripted",
            async generate(request) {
              const text = JSON.stringify(request.messages).replace(/\\"/g, '"');
              if (text.includes('"k":"b"')) {
                return { output: { k: "b" } };
              }
              return { output: { k: "a" } };
            },
          },
        },
      }),
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("planned", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const agents = await engine.store.listAgentRuns(run.id);
    expect(agents).toHaveLength(2);
    expect((await engine.store.getRun(run.id))?.output).toMatchObject({ a: { k: "a" }, b: { k: "b" } });
  });
});
