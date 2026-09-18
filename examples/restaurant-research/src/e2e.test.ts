import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDrassos, executeAgent, ScriptedModelProvider, tool } from "@drassos/engine";
import { createRestaurantApp, demoState, resetDemoState } from "./index.ts";

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

describe("restaurant research demo", () => {
  const engines: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    resetDemoState();
    while (engines.length > 0) {
      await engines.pop()?.stop();
    }
  });

  it("produces a structured recommendation from multiple tool turns", async () => {
    const engine = await createDrassos({
      inMemory: true,
      app: createRestaurantApp(),
      pollMs: 20,
      leaseMs: 2_000,
      logLevel: "silent",
    });
    engines.push(engine);
    await engine.startWorker();
    const run = await engine.executor.startRun("restaurant-research", {
      city: "Portland",
      partySize: 4,
      vegetarian: true,
    });
    await waitFor(async () => (await engine.store.getRun(run.id))?.status === "COMPLETED");
    const completed = await engine.store.getRun(run.id);
    expect(completed?.output).toMatchObject({
      restaurantId: "rest_cedar",
      confidence: 0.91,
    });
    expect(demoState.searches).toBe(1);
    expect(demoState.details).toBe(1);
    expect(demoState.menus).toBe(1);
    const history = await engine.store.listHistory(run.id);
    expect(history.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool.requested", "tool.started", "tool.completed", "agent.run.completed"]),
    );
  });

  it("does not repeat completed tools after a crash between tool B and the final model turn", async () => {
    const counts = { alpha: 0, beta: 0 };
    const ping = tool({
      name: "alpha",
      description: "alpha",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        counts.alpha += 1;
        return { n };
      },
    });
    const pong = tool({
      name: "beta",
      description: "beta",
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        counts.beta += 1;
        return { n };
      },
    });
    const engine = await createDrassos({
      inMemory: true,
      logLevel: "silent",
      tools: [ping, pong],
      models: {
        scripted: new ScriptedModelProvider([
          { toolCalls: [{ id: "a", name: "alpha", arguments: { n: 1 } }] },
          { toolCalls: [{ id: "b", name: "beta", arguments: { n: 2 } }] },
          { output: { restaurantId: "rest_cedar", reasoning: "ok", confidence: 1 } },
        ]),
      },
    });
    engines.push(engine);
    const run = await engine.store.createRun({
      workflowName: "seed",
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
    class Crash extends Error {
      constructor(public readonly checkpoint: string) {
        super(checkpoint);
      }
    }
    const definition = {
      name: "research",
      instructions: "research",
      model: "scripted:demo",
      allowedToolNames: ["alpha", "beta"],
      output: z.object({
        restaurantId: z.string(),
        reasoning: z.string(),
        confidence: z.number(),
      }),
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
          if (name === "after-tool" && counts.beta === 1) {
            throw new Crash(name);
          }
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Crash);
    }
    expect(counts.alpha).toBe(1);
    expect(counts.beta).toBe(1);
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
    expect(output).toMatchObject({ restaurantId: "rest_cedar" });
    expect(counts.alpha).toBe(1);
    expect(counts.beta).toBe(1);
  });
});
