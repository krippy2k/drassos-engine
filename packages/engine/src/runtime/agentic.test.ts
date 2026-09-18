import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLimitExceededError,
  AgentTimeoutError,
  ChildWorkflowError,
  createDrassos,
  executeAgent,
  mcp,
  tool,
  workflow,
} from "../index.ts";
import { agent } from "../sdk/agent.ts";
import { ScriptedAgentProvider } from "../agents/providers.ts";
import { McpConnectionError, McpProtocolError } from "../core/errors.ts";

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

class Crash extends Error {
  constructor(public readonly checkpoint: string) {
    super(`crash:${checkpoint}`);
    this.name = "Crash";
  }
}

describe("agentic orchestration", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  async function seed(engine: Awaited<ReturnType<typeof createDrassos>>) {
    const run = await engine.store.createRun({
      workflowName: "agent-seed",
      workflowVersion: "1",
      input: {},
    });
    const step = await engine.store.insertStep({
      runId: run.id,
      name: "agent",
      occurrence: 0,
      type: "agent",
      status: "RUNNING",
      attempt: 1,
      maxAttempts: 1,
    });
    return { run, step };
  }

  it("resumes the agent loop from each durable checkpoint without repeating completed work", async () => {
    const engine = await createDrassos({ inMemory: true, logLevel: "silent", workflows: [] });
    engines.push(engine);
    const checkpoints = [
      "before-model",
      "after-model",
      "before-tool",
      "after-tool",
      "between-turns",
      "before-complete",
      "agent-completed",
    ];
    const seen = new Set<string>();

    for (const stopAt of checkpoints) {
      const { run, step } = await seed(engine);
      const counts = { model: 0, tool: 0 };
      const lookup = tool({
        name: "lookup",
        description: "lookup",
        input: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          counts.tool += 1;
          return { id };
        },
      });
      const definition = agent({
        name: "recoverable",
        tools: [lookup],
        provider: {
          name: "counting",
          async execute() {
            counts.model += 1;
            if (counts.model === 1) {
              return { output: null, toolCalls: [{ id: "t1", name: "lookup", arguments: { id: "abc" } }] };
            }
            return { output: { done: true } };
          },
        },
      });
      try {
        await executeAgent({
          store: engine.store,
          runId: run.id,
          stepRunId: step.id,
          agent: definition,
          input: { id: "abc" },
          abortSignal: new AbortController().signal,
          onCheckpoint: async (name) => {
            seen.add(name);
            if (name === stopAt) {
              throw new Crash(name);
            }
          },
        });
        if (stopAt !== "agent-completed") {
          throw new Error(`expected crash at ${stopAt}`);
        }
      } catch (error) {
        if (!(error instanceof Crash) || error.checkpoint !== stopAt) {
          throw error;
        }
      }
      const output = await executeAgent({
        store: engine.store,
        runId: run.id,
        stepRunId: step.id,
        agent: definition,
        input: { id: "abc" },
        abortSignal: new AbortController().signal,
      });
      expect(output).toEqual({ done: true });
      expect(counts.model).toBe(2);
      expect(counts.tool).toBe(1);
    }
    expect([...seen]).toEqual(expect.arrayContaining(checkpoints));
  });

  it("enforces turn, tool, and timeout limits with typed errors", async () => {
    const engine = await createDrassos({ inMemory: true, logLevel: "silent" });
    engines.push(engine);

    const looping = agent({
      name: "loopy",
      limits: { maxTurns: 2 },
      provider: new ScriptedAgentProvider([
        { output: null, toolCalls: [{ id: "1", name: "missing", arguments: {} }] },
        { output: null, toolCalls: [{ id: "2", name: "missing", arguments: {} }] },
        { output: { extra: true } },
      ]),
    });
    const { run, step } = await seed(engine);
    await expect(
      executeAgent({
        store: engine.store,
        runId: run.id,
        stepRunId: step.id,
        agent: looping,
        input: {},
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AgentLimitExceededError);

    const toolish = tool({
      name: "ping",
      description: "ping",
      input: z.object({}),
      execute: async () => "pong",
    });
    const toolLimited = agent({
      name: "tools",
      tools: [toolish],
      limits: { maxToolCalls: 1 },
      provider: new ScriptedAgentProvider([
        { output: null, toolCalls: [{ id: "1", name: "ping", arguments: {} }] },
        { output: null, toolCalls: [{ id: "2", name: "ping", arguments: {} }] },
        { output: { ok: true } },
      ]),
    });
    const second = await seed(engine);
    await expect(
      executeAgent({
        store: engine.store,
        runId: second.run.id,
        stepRunId: second.step.id,
        agent: toolLimited,
        input: {},
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AgentLimitExceededError);

    const slow = agent({
      name: "slow",
      limits: { timeout: 30 },
      provider: {
        name: "slow",
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { output: "late" };
        },
      },
    });
    const third = await seed(engine);
    await expect(
      executeAgent({
        store: engine.store,
        runId: third.run.id,
        stepRunId: third.step.id,
        agent: slow,
        input: {},
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AgentTimeoutError);

    const edge = agent({
      name: "edge",
      limits: { maxTurns: 1 },
      provider: new ScriptedAgentProvider([{ output: { just: "in time" } }]),
    });
    const fourth = await seed(engine);
    await expect(
      executeAgent({
        store: engine.store,
        runId: fourth.run.id,
        stepRunId: fourth.step.id,
        agent: edge,
        input: {},
        abortSignal: new AbortController().signal,
      }),
    ).resolves.toEqual({ just: "in time" });
  });

  it("redacts sensitive payloads when observability recording is disabled", async () => {
    const engine = await createDrassos({ inMemory: true, logLevel: "silent" });
    engines.push(engine);
    const { run, step } = await seed(engine);
    const ping = tool({
      name: "secret",
      description: "secret",
      input: z.object({ password: z.string() }),
      execute: async () => ({ token: "shh" }),
    });
    const definition = agent({
      name: "private",
      tools: [ping],
      observability: {
        recordPrompts: false,
        recordResponses: false,
        recordToolArguments: false,
        recordToolResults: false,
      },
      provider: new ScriptedAgentProvider([
        { output: null, toolCalls: [{ id: "1", name: "secret", arguments: { password: "hunter2" } }] },
        { output: { secret: "nope" } },
      ]),
    });
    await executeAgent({
      store: engine.store,
      runId: run.id,
      stepRunId: step.id,
      agent: definition,
      input: { password: "hunter2" },
      abortSignal: new AbortController().signal,
    });
    const modelCalls = await engine.store.listModelCalls((await engine.store.listAgentRuns(run.id))[0]!.id);
    expect(modelCalls[0]?.request).toBe("[redacted]");
    const toolCalls = await engine.store.listToolCalls({ runId: run.id });
    expect(toolCalls[0]?.arguments).toBe("[redacted]");
    expect(toolCalls[0]?.result).toBe("[redacted]");
  });

  it("discovers and invokes MCP tools, including errors, reuse, and concurrency", async () => {
    const engine = await createDrassos({ inMemory: true, logLevel: "silent" });
    engines.push(engine);
    const server = mcp.memory("math", [
      {
        name: "add",
        description: "add two numbers",
        execute: async (input) => {
          const { a, b } = input as { a: number; b: number };
          if (typeof a !== "number") {
            throw new McpProtocolError("invalid arguments");
          }
          return { sum: a + b };
        },
      },
      {
        name: "fail",
        description: "always fails",
        execute: async () => {
          throw new McpProtocolError("boom");
        },
      },
    ]);
    const tools = await engine.mcp.toolsFor(server);
    expect(tools.map((item) => item.name).sort()).toEqual(["add", "fail"]);
    const [first, second] = await Promise.all([
      tools[0]!.execute({ a: 2, b: 3 }),
      tools[0]!.execute({ a: 4, b: 5 }),
    ]);
    expect(first).toEqual({ sum: 5 });
    expect(second).toEqual({ sum: 9 });
    await expect(tools[1]!.execute({})).rejects.toBeInstanceOf(McpProtocolError);
    const again = await engine.mcp.toolsFor(server);
    expect(again).toHaveLength(2);

    await expect(engine.mcp.toolsFor(mcp.http({ url: "http://127.0.0.1:1" }))).rejects.toBeInstanceOf(
      McpConnectionError,
    );

    const reconnects = { n: 0 };
    const flaky = mcp.memory("flaky", [
      {
        name: "echo",
        description: "echo",
        execute: async (input) => {
          reconnects.n += 1;
          if (reconnects.n === 1) {
            throw new McpConnectionError("disconnected");
          }
          return input;
        },
      },
    ]);
    const flakyTools = await engine.mcp.toolsFor(flaky);
    await expect(flakyTools[0]!.execute({ ok: true })).resolves.toEqual({ ok: true });
    expect(reconnects.n).toBe(2);
  });

  it("runs, fails, cancels, and nests child workflows across worker restarts", async () => {
    const childOk = workflow("child-ok", async (ctx) => {
      await ctx.step("work", async () => "child-result");
      return "child-result";
    });
    const childFail = workflow("child-fail", async () => {
      throw new Error("child exploded");
    });
    const childSlow = workflow("child-slow", async (ctx) => {
      await ctx.sleep("nap", 250);
      return "slow-result";
    });
    const nested = workflow("nested-parent", async (ctx) => {
      return ctx.workflow.run(childOk, {});
    });
    const parentOk = workflow("parent-ok", async (ctx) => {
      const inner = await ctx.workflow.run(nested, {});
      return { inner };
    });
    const parentFail = workflow("parent-fail", async (ctx) => {
      await ctx.workflow.run(childFail, {});
    });
    const parentWait = workflow("parent-wait", async (ctx) => {
      return ctx.workflow.run(childSlow, {});
    });
    const parentCancel = workflow("parent-cancel", async (ctx) => {
      return ctx.workflow.run(childSlow, {});
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      leaseMs: 2_000,
      workflows: [childOk, childFail, childSlow, nested, parentOk, parentFail, parentWait, parentCancel],
    });
    engines.push(engine);
    await engine.startWorker();

    const ok = await engine.executor.startRun("parent-ok", {});
    await waitFor(async () => (await engine.store.getRun(ok.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(ok.id))?.output).toEqual({ inner: "child-result" });
    expect(await engine.store.listChildren(ok.id)).toHaveLength(1);

    const failed = await engine.executor.startRun("parent-fail", {});
    await waitFor(async () => (await engine.store.getRun(failed.id))?.status === "FAILED");
    expect((await engine.store.getRun(failed.id))?.error?.name).toBe("ChildWorkflowError");

    const waiting = await engine.executor.startRun("parent-wait", {});
    await waitFor(async () => (await engine.store.getRun(waiting.id))?.waitType === "child");
    await engine.worker.stop();
    await engine.startWorker();
    await waitFor(async () => (await engine.store.getRun(waiting.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(waiting.id))?.output).toBe("slow-result");

    const cancellable = await engine.executor.startRun("parent-cancel", {});
    await waitFor(async () => (await engine.store.getRun(cancellable.id))?.waitType === "child");
    const childRuns = await engine.store.listChildren(cancellable.id);
    expect(childRuns.length).toBe(1);
    await engine.executor.cancelRun(cancellable.id, "stop");
    await waitFor(async () => (await engine.store.getRun(cancellable.id))?.status === "CANCELLED");
    await waitFor(async () => (await engine.store.getRun(childRuns[0]!.id))?.status === "CANCELLED");

    let depth: ReturnType<typeof workflow>;
    depth = workflow("deep", async (ctx) => ctx.workflow.run(depth, {}));
    const shallow = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      maxChildDepth: 1,
      workflows: [depth],
    });
    engines.push(shallow);
    await shallow.startWorker();
    const deepRun = await shallow.executor.startRun("deep", {});
    await waitFor(async () => (await shallow.store.getRun(deepRun.id))?.status === "FAILED");
    expect((await shallow.store.getRun(deepRun.id))?.error?.name).toBe("ChildWorkflowError");
    expect(ChildWorkflowError).toBeTruthy();
  });

  it("pins existing runs to the definition version they started with", async () => {
    const v1 = workflow(
      "versioned",
      async (ctx) => {
        await ctx.human("gate", { title: "hold v1" });
        return "v1";
      },
      { version: "1" },
    );
    const v2 = workflow("versioned", async () => "v2", { version: "2" });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [v1],
    });
    engines.push(engine);
    await engine.startWorker();
    const first = await engine.executor.startRun("versioned", {});
    await waitFor(async () => (await engine.store.getRun(first.id))?.status === "WAITING");
    expect((await engine.store.getRun(first.id))?.workflowVersion).toBe("1");

    engine.registry.register(v2);
    await engine.store.registerWorkflow(v2.name, v2.version);
    const second = await engine.executor.startRun("versioned", {});
    await waitFor(async () => (await engine.store.getRun(second.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(second.id))?.workflowVersion).toBe("2");
    expect((await engine.store.getRun(second.id))?.output).toBe("v2");

    const tasks = await engine.store.listHumanTasks({ runId: first.id, status: "pending" });
    await engine.executor.completeHumanTask(tasks[0]!.id, { ok: true });
    await waitFor(async () => (await engine.store.getRun(first.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(first.id))?.workflowVersion).toBe("1");
    expect((await engine.store.getRun(first.id))?.output).toBe("v1");
  });
});
