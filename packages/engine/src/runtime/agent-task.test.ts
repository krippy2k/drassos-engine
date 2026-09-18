import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentLimitExceededError,
  AgentTimeoutError,
  createDrassos,
  executeAgent,
  executeAuthorizedTool,
  InvalidToolRequestError,
  ModelRegistry,
  ScriptedModelProvider,
  selectAuthorizedTool,
  StructuredOutputError,
  tool,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolRegistry,
  UnauthorizedToolError,
  UnknownToolError,
  workflow,
} from "../index.ts";
import type { ModelProvider, ModelRequest, ModelResponse } from "../models/model-types.ts";
import { agentResultFromModel, modelRequestFromAgent } from "../agents/providers.ts";

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

describe("v0.3 agent tasks", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => {
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("registers providers and tools", () => {
    const models = new ModelRegistry();
    const provider = new ScriptedModelProvider([{ output: "ok" }], "openai");
    models.register("openai", provider);
    expect(models.resolve("openai:gpt-5.6").model).toBe("gpt-5.6");
    expect(models.get("openai")).toBe(provider);

    const tools = new ToolRegistry();
    const weather = tool({
      name: "getWeather",
      description: "weather",
      input: z.object({ city: z.string() }),
      handler: async ({ city }) => ({ city, temp: 70 }),
    });
    tools.register(weather);
    expect(tools.require("getWeather").name).toBe("getWeather");
    expect(() => tools.require("missing")).toThrow(UnknownToolError);
  });

  it("authorizes only explicitly granted tools", () => {
    const allowed = [
      tool({
        name: "searchRestaurants",
        description: "search",
        input: z.object({ city: z.string() }),
        execute: async () => [],
      }),
    ];
    expect(selectAuthorizedTool("searchRestaurants", allowed).name).toBe("searchRestaurants");
    expect(() => selectAuthorizedTool("deleteDatabase", allowed)).toThrow(UnauthorizedToolError);
    expect(() => selectAuthorizedTool("deleteDatabase", [])).toThrow(UnknownToolError);
  });

  it("validates tool input and output without invoking bad handlers", async () => {
    let called = 0;
    const echo = tool({
      name: "echo",
      description: "echo",
      input: z.object({ city: z.string() }),
      output: z.object({ city: z.string() }),
      execute: async (input) => {
        called += 1;
        return input;
      },
    });
    await expect(
      executeAuthorizedTool(echo, { city: 1 }, {
        runId: "r",
        workflowId: "r",
        agentExecutionId: "a",
        toolCallId: "t",
        idempotencyKey: "t",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolInputValidationError);
    expect(called).toBe(0);

    const badOut = tool({
      name: "bad",
      description: "bad",
      input: z.object({ city: z.string() }),
      output: z.object({ temp: z.number() }),
      execute: async () => ({ temp: "hot" }),
    });
    await expect(
      executeAuthorizedTool(badOut, { city: "x" }, {
        runId: "r",
        workflowId: "r",
        agentExecutionId: "a",
        toolCallId: "t",
        idempotencyKey: "t",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ToolOutputValidationError);
  });

  it("normalizes model responses through the provider-independent interface", () => {
    const request = {
      instructions: "sys",
      input: { q: 1 },
      messages: [],
      tools: [],
      model: "gpt",
    };
    const modelReq = modelRequestFromAgent(request);
    expect(modelReq.messages[0]?.role).toBe("system");
    const result = agentResultFromModel(request, {
      output: { ok: true },
      content: "{\"ok\":true}",
      finishReason: "stop",
    });
    expect(result.output).toEqual({ ok: true });
  });

  it("completes a single-turn agent task and a multi-turn tool loop", async () => {
    const lookup = tool({
      name: "lookup",
      description: "lookup",
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ id, found: true }),
    });
    const demo = workflow("task-loop", async (ctx) => {
      const one = await ctx.agent("single", {
        model: "scripted:one",
        prompt: "answer",
      });
      const many = await ctx.agent("multi", {
        model: "scripted:many",
        prompt: "use tools",
        tools: ["lookup"],
      });
      return { one, many };
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      tools: [lookup],
      models: {
        scripted: new ScriptedModelProvider([
          { output: { ready: true } },
          { toolCalls: [{ id: "1", name: "lookup", arguments: { id: "abc" } }] },
          { output: { summary: "found" } },
        ]),
      },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("task-loop", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual({
      one: { ready: true },
      many: { summary: "found" },
    });
  });

  it("validates structured output and retries a turn before failing", async () => {
    const schema = z.object({ restaurantId: z.string(), reasoning: z.string(), confidence: z.number() });
    const demo = workflow("structured", async (ctx) =>
      ctx.agent("pick", {
        model: "scripted:x",
        prompt: "pick",
        output: schema,
        maxTurns: 2,
      }),
    );
    const retryEngine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      models: {
        scripted: new ScriptedModelProvider([
          { output: { nope: true } },
          { output: { restaurantId: "r1", reasoning: "good", confidence: 0.8 } },
        ]),
      },
    });
    engines.push(retryEngine);
    await retryEngine.startWorker();
    const ok = await retryEngine.executor.startRun("structured", {});
    await waitFor(async () => (await retryEngine.store.getRun(ok.id))?.status === "COMPLETED");
    expect((await retryEngine.store.getRun(ok.id))?.output).toMatchObject({ restaurantId: "r1" });

    const failEngine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      models: {
        scripted: new ScriptedModelProvider([{ output: { nope: true } }, { output: { still: "bad" } }]),
      },
    });
    engines.push(failEngine);
    await failEngine.startWorker();
    const failed = await failEngine.executor.startRun("structured", {});
    await waitFor(async () => (await failEngine.store.getRun(failed.id))?.status === "FAILED");
    expect((await failEngine.store.getRun(failed.id))?.error?.name).toBe("StructuredOutputError");
    expect(StructuredOutputError).toBeTruthy();
  });

  it("does not execute unlisted or malformed tool calls", async () => {
    const counts = { ok: 0, secret: 0 };
    const allowed = tool({
      name: "ok",
      description: "ok",
      input: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        counts.ok += 1;
        return { city };
      },
    });
    const secret = tool({
      name: "secret",
      description: "secret",
      input: z.object({ city: z.string() }),
      execute: async () => {
        counts.secret += 1;
        return { leaked: true };
      },
    });
    const demo = workflow("secure", async (ctx) =>
      ctx.agent("locked", {
        model: "scripted:x",
        prompt: "try",
        tools: ["ok"],
      }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      tools: [allowed, secret],
      models: {
        scripted: new ScriptedModelProvider([
          { toolCalls: [{ id: "1", name: "secret", arguments: { city: "x" } }] },
          { toolCalls: [{ id: "2", name: "ok", arguments: { city: 12 } }] },
          { output: { done: true } },
        ]),
      },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("secure", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect(counts.secret).toBe(0);
    expect(counts.ok).toBe(0);
    const toolCalls = await engine.store.listToolCalls({ runId: run.id });
    expect(toolCalls.every((call) => call.status === "FAILED")).toBe(true);
    expect(toolCalls.some((call) => call.error?.name === "UnauthorizedToolError")).toBe(true);
    expect(toolCalls.some((call) => call.error?.name === "ToolInputValidationError")).toBe(true);
  });

  it("cancels an in-flight agent without scheduling further tools", async () => {
    const demo = workflow("cancel-agent", async (ctx) => {
      await ctx.agent("slow", {
        model: "scripted:x",
        prompt: "hold",
      });
      await ctx.sleep("later", 5_000);
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      models: {
        scripted: new ScriptedModelProvider([{ output: { ok: true } }]),
      },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("cancel-agent", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "WAITING");
    await engine.executor.cancelRun(run.id, "stop");
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "CANCELLED");
    const agents = await engine.store.listAgentRuns(run.id);
    expect(agents[0]?.status === "COMPLETED" || agents[0]?.status === "CANCELLED").toBe(true);
  });

  it("resumes after crashes at v0.3 durable boundaries", async () => {
    const engine = await createDrassos({ inMemory: true, logLevel: "silent" });
    engines.push(engine);
    const counts = { model: 0, tool: 0 };
    const ping = tool({
      name: "ping",
      description: "ping",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        counts.tool += 1;
        return { n };
      },
    });
    engine.tools.register(ping);
    engine.models.register(
      "scripted",
      new ScriptedModelProvider([
        { toolCalls: [{ id: "1", name: "ping", arguments: { n: 1 } }] },
        { output: { done: true } },
      ]),
    );
    class Crash extends Error {
      constructor(public readonly checkpoint: string) {
        super(checkpoint);
      }
    }
    for (const stopAt of ["agent-started", "after-model", "tool-requested", "tool-started", "after-tool", "between-turns", "agent-completed"]) {
      counts.model = 0;
      counts.tool = 0;
      const provider = new ScriptedModelProvider([
        { toolCalls: [{ id: "1", name: "ping", arguments: { n: 1 } }] },
        { output: { done: true } },
      ]);
      engine.models.register("scripted", provider);
      const run = await engine.store.createRun({ workflowName: "seed", workflowVersion: "1", input: {} });
      const step = await engine.store.insertStep({
        runId: run.id,
        name: "agent",
        occurrence: 0,
        type: "agent",
        status: "RUNNING",
        attempt: 1,
        maxAttempts: 1,
      });
      const definition = {
        name: "bounded",
        instructions: "go",
        model: "scripted:x",
        allowedToolNames: ["ping"],
      };
      try {
        await executeAgent({
          store: engine.store,
          runId: run.id,
          stepRunId: step.id,
          agent: definition,
          input: {},
          abortSignal: new AbortController().signal,
          models: engine.models,
          toolRegistry: engine.tools,
          onCheckpoint: async (name) => {
            if (name === stopAt) {
              throw new Crash(name);
            }
          },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Crash);
      }
      const output = await executeAgent({
        store: engine.store,
        runId: run.id,
        stepRunId: step.id,
        agent: definition,
        input: {},
        abortSignal: new AbortController().signal,
        models: engine.models,
        toolRegistry: engine.tools,
      });
      expect(output).toEqual({ done: true });
      expect(counts.tool).toBe(1);
    }
  });

  it("executes multiple sequential tools from a single model turn", async () => {
    const counts = { a: 0, b: 0 };
    const alpha = tool({
      name: "alpha",
      description: "alpha",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        counts.a += 1;
        return { n };
      },
    });
    const beta = tool({
      name: "beta",
      description: "beta",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        counts.b += 1;
        return { n };
      },
    });
    const demo = workflow("seq-tools", async (ctx) =>
      ctx.agent("pair", {
        model: "scripted:x",
        prompt: "both",
        tools: ["alpha", "beta"],
      }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      tools: [alpha, beta],
      models: {
        scripted: new ScriptedModelProvider([
          {
            toolCalls: [
              { id: "a", name: "alpha", arguments: { n: 1 } },
              { id: "b", name: "beta", arguments: { n: 2 } },
            ],
          },
          { output: { done: true } },
        ]),
      },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("seq-tools", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect((await engine.store.getRun(run.id))?.output).toEqual({ done: true });
    expect(counts).toEqual({ a: 1, b: 1 });
  });

  it("enforces turn and tool-call limits", async () => {
    const ping = tool({
      name: "ping",
      description: "ping",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ n }),
    });
    const turns = workflow("limit-turns", async (ctx) =>
      ctx.agent("loop", {
        model: "turns:x",
        prompt: "loop",
        tools: ["ping"],
        maxTurns: 1,
      }),
    );
    const toolsLimit = workflow("limit-tools", async (ctx) =>
      ctx.agent("loop", {
        model: "tools:x",
        prompt: "loop",
        tools: ["ping"],
        maxToolCalls: 1,
      }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [turns, toolsLimit],
      tools: [ping],
      models: {
        turns: new ScriptedModelProvider([
          { toolCalls: [{ id: "1", name: "ping", arguments: { n: 1 } }] },
          { toolCalls: [{ id: "2", name: "ping", arguments: { n: 2 } }] },
        ]),
        tools: new ScriptedModelProvider([
          {
            toolCalls: [
              { id: "1", name: "ping", arguments: { n: 1 } },
              { id: "2", name: "ping", arguments: { n: 2 } },
            ],
          },
        ]),
      },
    });
    engines.push(engine);
    await engine.startWorker();
    const turnRun = await engine.executor.startRun("limit-turns", {});
    await waitFor(async () => (await engine.store.getRun(turnRun.id))?.status === "FAILED");
    expect((await engine.store.getRun(turnRun.id))?.error?.name).toBe("AgentLimitExceededError");
    const toolRun = await engine.executor.startRun("limit-tools", {});
    await waitFor(async () => (await engine.store.getRun(toolRun.id))?.status === "FAILED");
    expect((await engine.store.getRun(toolRun.id))?.error?.name).toBe("AgentLimitExceededError");
    expect(AgentLimitExceededError).toBeTruthy();
  });

  it("times out a hung model request", async () => {
    const hang: ModelProvider = {
      name: "hang",
      async generate(request: ModelRequest): Promise<ModelResponse> {
        await new Promise<void>((_resolve, reject) => {
          if (request.abortSignal?.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          request.abortSignal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        return { output: "late" };
      },
    };
    const demo = workflow("timeout-agent", async (ctx) =>
      ctx.agent("slow", {
        model: "hang:x",
        prompt: "wait",
        timeout: 50,
      }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      models: { hang },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("timeout-agent", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "FAILED");
    const errorName = (await engine.store.getRun(run.id))?.error?.name;
    expect(["AgentTimeoutError", "ModelTimeoutError", "TimeoutError"]).toContain(errorName);
    expect(AgentTimeoutError).toBeTruthy();
  });

  it("cancels an in-flight model call before any tool runs", async () => {
    let tools = 0;
    const boom = tool({
      name: "boom",
      description: "boom",
      input: z.object({ x: z.string() }),
      execute: async () => {
        tools += 1;
        return { ok: true };
      },
    });
    const hang: ModelProvider = {
      name: "hang",
      async generate(request: ModelRequest): Promise<ModelResponse> {
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (request.abortSignal?.aborted) {
            fail();
            return;
          }
          request.abortSignal?.addEventListener("abort", fail, { once: true });
        });
        return { toolCalls: [{ id: "1", name: "boom", arguments: { x: "1" } }] };
      },
    };
    const demo = workflow("cancel-hang", async (ctx) =>
      ctx.agent("slow", {
        model: "hang:x",
        prompt: "wait",
        tools: ["boom"],
      }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      tools: [boom],
      models: { hang },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("cancel-hang", {});
    await waitFor(async () => (await engine.store.listAgentRuns(run.id)).length > 0);
    await engine.executor.cancelRun(run.id, "stop-model");
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "CANCELLED");
    expect(tools).toBe(0);
    const agents = await engine.store.listAgentRuns(run.id);
    expect(agents[0]?.status).toBe("CANCELLED");
  });

  it("rejects nameless tool calls without invoking handlers", async () => {
    let called = 0;
    const ping = tool({
      name: "ping",
      description: "ping",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        called += 1;
        return { n };
      },
    });
    const demo = workflow("invalid-call", async (ctx) =>
      ctx.agent("bad", {
        model: "scripted:x",
        prompt: "try",
        tools: ["ping"],
      }),
    );
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      pollMs: 20,
      workflows: [demo],
      tools: [ping],
      models: {
        scripted: new ScriptedModelProvider([
          { toolCalls: [{ id: "1", name: "", arguments: { n: 1 } }] },
          { output: { done: true } },
        ]),
      },
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("invalid-call", {});
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    expect(called).toBe(0);
    const toolCalls = await engine.store.listToolCalls({ runId: run.id });
    expect(toolCalls[0]?.error?.name).toBe("InvalidToolRequestError");
    expect(InvalidToolRequestError).toBeTruthy();
  });
});
