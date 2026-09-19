import { Drassos, type NodeConfig, type ExecutionResult } from "@drassos/node";
import type {
  Clock,
  HistoryEvent,
  HumanDecision,
  HumanInteraction,
  ToolDefinition,
  WorkflowDefinition,
  WorkflowRun,
} from "@drassos/core";

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(date: Date): void;
}

export function createFakeClock(start = new Date("2026-01-01T00:00:00.000Z")): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
    set(date: Date) {
      current = date.getTime();
    },
  };
}

export interface TestRuntimeOptions extends Omit<NodeConfig, "inMemory" | "clock"> {
  workflows?: WorkflowDefinition[];
  tools?: ToolDefinition[];
  clock?: Clock;
}

export interface TestRuntime {
  execute<TInput = unknown, TOutput = unknown>(
    workflow: WorkflowDefinition<TInput, TOutput> | string,
    input?: TInput,
    options?: { version?: string; timeoutMs?: number },
  ): Promise<ExecutionResult<TOutput>>;
  start<TInput = unknown, TOutput = unknown>(
    workflow: WorkflowDefinition<TInput, TOutput> | string,
    input?: TInput,
    options?: { version?: string },
  ): Promise<{ runId: string }>;
  wait(runId: string, timeoutMs?: number): Promise<ExecutionResult>;
  signal(runId: string, name: string, payload?: unknown): Promise<{ signalId: string; duplicate: boolean }>;
  completeInteraction(
    runId: string,
    interactionId: string,
    decision: HumanDecision | Record<string, unknown>,
  ): Promise<HumanInteraction>;
  approve(runId: string, interactionId: string, data?: unknown): Promise<HumanInteraction>;
  getPendingInteractions(runId?: string): Promise<HumanInteraction[]>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  history(runId: string): Promise<HistoryEvent[]>;
  clock?: Clock;
  runtime(): Drassos;
  stop(): Promise<void>;
}

export async function createTestRuntime(options: TestRuntimeOptions = {}): Promise<TestRuntime> {
  const { workflows, tools, clock, ...rest } = options;
  const drassos = new Drassos({
    ...rest,
    inMemory: true,
    pollMs: options.pollMs ?? 20,
    logLevel: options.logLevel ?? "silent",
    clock,
    workflows,
    tools,
  });
  await drassos.start();

  return {
    clock: options.clock,
    runtime: () => drassos,
    execute: (workflow, input, executeOptions) => drassos.execute(workflow, input, executeOptions),
    async start(workflow, input, startOptions) {
      if (typeof workflow !== "string") {
        drassos.register(workflow as WorkflowDefinition);
      }
      const name = typeof workflow === "string" ? workflow : workflow.name;
      const run = await drassos.runtime().executor.startRun(name, input ?? {}, undefined, {
        version: startOptions?.version,
      });
      return { runId: run.id };
    },
    wait: (runId, timeoutMs) => drassos.wait(runId, timeoutMs),
    signal: (runId, name, payload) => drassos.signal(runId, name, payload),
    completeInteraction: (runId, interactionId, decision) =>
      drassos.completeInteraction(runId, interactionId, decision),
    approve: (runId, interactionId, data) =>
      drassos.completeInteraction(runId, interactionId, { outcome: "approved", data }),
    getPendingInteractions: (runId) => drassos.getPendingInteractions(runId),
    getRun: (runId) => drassos.getRun(runId),
    history: (runId) => drassos.history(runId),
    stop: () => drassos.stop(),
  };
}
