import { randomUUID } from "node:crypto";
import {
  ReplayDivergenceError,
  UnsupportedHistoryFormatError,
  WorkflowSuspend,
  type ReplayDivergence,
} from "../core/errors.ts";
import { OccurrenceCounter } from "../core/identity.ts";
import { HISTORY_FORMAT_VERSION } from "../core/version.ts";
import type { HistoryEvent, Json, StepRun, WorkflowRun } from "../core/types.ts";
import type {
  AgentDefinition,
  AgentTaskOptions,
  ChildExecutionOptions,
  WorkflowContext,
  WorkflowDefinition,
} from "../sdk/types.ts";
import { redactSecrets } from "../observability/redact.ts";
import type { RemoteAgent } from "./a2a.ts";

export interface DeterministicValue {
  kind: "now" | "random" | "uuid";
  occurrence: number;
  value: Json;
}

export interface ExecutionExport {
  formatVersion: number;
  execution: {
    id: string;
    workflow: string;
    workflowVersion: string;
    status: string;
    input: unknown;
    output: unknown;
    waitType: string | null;
    error: unknown;
  };
  history: HistoryEvent[];
  steps: StepRun[];
  deterministicValues: DeterministicValue[];
}

export interface ReplayResult {
  ok: boolean;
  executionId: string;
  workflowName: string;
  recordedVersion: string;
  testedVersion: string;
  eventsReplayed: number;
  divergences: ReplayDivergence[];
  durationMs: number;
  output: unknown;
  suspended: boolean;
}

export function exportExecution(source: {
  run: WorkflowRun;
  history: HistoryEvent[];
  steps: StepRun[];
  deterministicValues?: DeterministicValue[];
}): ExecutionExport {
  return {
    formatVersion: source.run.historyFormatVersion ?? HISTORY_FORMAT_VERSION,
    execution: {
      id: source.run.id,
      workflow: source.run.workflowName,
      workflowVersion: source.run.workflowVersion,
      status: source.run.status,
      input: redactSecrets(source.run.input),
      output: redactSecrets(source.run.output),
      waitType: source.run.waitType,
      error: source.run.error,
    },
    history: source.history.map((event) => ({ ...event, payload: redactSecrets(event.payload) as HistoryEvent["payload"] })),
    steps: source.steps.map((step) => ({
      ...step,
      input: redactSecrets(step.input) as StepRun["input"],
      output: redactSecrets(step.output) as StepRun["output"],
    })),
    deterministicValues: source.deterministicValues ?? [],
  };
}

export function assertHistoryFormat(formatVersion: number): void {
  if (formatVersion !== HISTORY_FORMAT_VERSION) {
    throw new UnsupportedHistoryFormatError(formatVersion);
  }
}

export async function replayDefinition(
  definition: WorkflowDefinition,
  bundle: ExecutionExport,
): Promise<ReplayResult> {
  const started = Date.now();
  assertHistoryFormat(bundle.formatVersion);
  const ctx = new ReplayContext(bundle, definition.version);
  const result: ReplayResult = {
    ok: true,
    executionId: bundle.execution.id,
    workflowName: bundle.execution.workflow,
    recordedVersion: bundle.execution.workflowVersion,
    testedVersion: definition.version,
    eventsReplayed: bundle.history.length,
    divergences: [],
    durationMs: 0,
    output: null,
    suspended: false,
  };
  try {
    const output = await definition.fn(ctx as never);
    ctx.finish("completed");
    result.output = output;
  } catch (error) {
    if (error instanceof WorkflowSuspend) {
      result.suspended = true;
      try {
        ctx.finish("waiting");
      } catch (inner) {
        if (inner instanceof ReplayDivergenceError) {
          result.ok = false;
          result.divergences.push(inner.divergence);
        } else {
          throw inner;
        }
      }
    } else if (error instanceof ReplayDivergenceError) {
      result.ok = false;
      result.divergences.push(error.divergence);
    } else {
      throw error;
    }
  }
  result.durationMs = Date.now() - started;
  return result;
}

class ReplayContext<TInput = unknown> {
  readonly input: TInput;
  readonly runId: string;
  readonly workflowName: string;
  readonly abortSignal = new AbortController().signal;
  readonly agent: WorkflowContext<TInput>["agent"];
  readonly human: WorkflowContext<TInput>["human"];
  readonly workflow: WorkflowContext<TInput>["workflow"];
  readonly tool: WorkflowContext<TInput>["tool"];
  private readonly occurrences = new OccurrenceCounter();
  private readonly clocks = new OccurrenceCounter();
  private readonly consumed = new Set<string>();

  constructor(
    private readonly bundle: ExecutionExport,
    private readonly testedVersion: string,
  ) {
    this.input = bundle.execution.input as TInput;
    this.runId = bundle.execution.id;
    this.workflowName = bundle.execution.workflow;
    const agentFn = ((name: string) => this.consume(String(name), "agent")) as WorkflowContext<TInput>["agent"];
    agentFn.run = (agent: AgentDefinition, options?: { name?: string; input?: unknown }) =>
      this.consume(options?.name ?? agent.name, "agent") as Promise<never>;
    this.agent = agentFn;
    this.tool = (target) => ({
      run: (input?: unknown) => this.consume("name" in target ? String(target.name) : "tool", "step", input) as Promise<never>,
    });
    const humanFn = ((name: string) => this.consume(name, "human")) as WorkflowContext<TInput>["human"];
    humanFn.approve = () => this.consume("approve", "human") as Promise<never>;
    this.human = humanFn;
    const workflowFn = ((name: string) => this.consume(name, "child")) as WorkflowContext<TInput>["workflow"];
    workflowFn.run = (definition, _input, options) =>
      this.consume(options?.name ?? definition.name, "child") as Promise<never>;
    this.workflow = workflowFn;
  }

  now(): Date {
    return new Date(String(this.clock("now")));
  }

  random(): number {
    return Number(this.clock("random"));
  }

  uuid(): string {
    return String(this.clock("uuid"));
  }

  async step<T>(name: string, _optionsOrFn?: unknown, _maybeFn?: unknown): Promise<T> {
    return (await this.consume(name, "step")) as T;
  }

  async activity<T>(name: string, input?: unknown, _options?: unknown): Promise<T> {
    return (await this.consume(name, "activity", input)) as T;
  }

  async sleep(nameOrDuration: string | number, maybeDuration?: string | number): Promise<void> {
    const name = maybeDuration !== undefined ? String(nameOrDuration) : "__sleep";
    await this.consume(name, "timer");
  }

  async waitForEvent<T>(type: string): Promise<T> {
    return (await this.consume(`event:${type}`, "event")) as T;
  }

  async waitForSignal<T>(name: string): Promise<T> {
    return (await this.consume(`signal:${name}`, "signal")) as T;
  }

  async approval<T>(options: { id: string }): Promise<T> {
    return (await this.consume(`approval:${options.id}`, "human")) as T;
  }

  async startWorkflow<T>(name: string): Promise<{ executionId: string; result: () => Promise<T>; status: () => Promise<"COMPLETED">; cancel: () => Promise<void> }> {
    const output = (await this.consume(name, "child")) as T;
    return {
      executionId: "replay-child",
      result: async () => output,
      status: async () => "COMPLETED",
      cancel: async () => undefined,
    };
  }

  async map<T, R>(items: T[], callback: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += 1) {
      out.push(await callback(items[i] as T, i));
    }
    return out;
  }

  async executePlan(plan: { tasks: Array<{ id: string; type: string; target: string }> }): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    for (const task of plan.tasks) {
      results[task.id] = await this.consume(`plan:${task.id}`, task.type === "workflow" ? "child" : "agent");
    }
    return results;
  }

  async parallel<const T extends ReadonlyArray<() => Promise<unknown>>>(fns: T): Promise<{ [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never }> {
    return Promise.all(fns.map((fn) => fn())) as Promise<{ [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never }>;
  }

  finish(outcome: "completed" | "waiting"): void {
    const leftover = this.bundle.steps.filter((step) => {
      const key = `${step.name}:${step.occurrence}`;
      if (this.consumed.has(key)) {
        return false;
      }
      if (outcome === "waiting" && (step.status === "WAITING" || step.status === "PENDING")) {
        return false;
      }
      return step.status === "COMPLETED" || step.status === "WAITING";
    });
    if (leftover[0]) {
      this.diverge("OPERATION_REMOVED", leftover[0].name, "(workflow returned)", leftover[0]);
    }
  }

  private clock(kind: DeterministicValue["kind"]): Json {
    const occurrence = this.clocks.next(kind);
    const recorded = this.bundle.deterministicValues.find((item) => item.kind === kind && item.occurrence === occurrence);
    if (!recorded) {
      this.diverge("OPERATION_ADDED", `ctx.${kind}()`, `ctx.${kind}()`, null);
    }
    return recorded!.value;
  }

  private async consume(name: string, type: StepRun["type"], input?: unknown): Promise<unknown> {
    const occurrence = this.occurrences.next(name);
    const step = this.bundle.steps.find((item) => item.name === name && item.occurrence === occurrence);
    if (!step) {
      const unused = this.bundle.steps.filter((item) => !this.consumed.has(`${item.name}:${item.occurrence}`));
      const laterSame = unused.find((item) => item.name === name);
      const next = unused[0];
      if (laterSame) {
        this.diverge("ORDER_CHANGED", this.peekExpected(), `${type}(${name})`, laterSame);
      }
      if (next) {
        this.diverge("OPERATION_CHANGED", `${next.type}(${next.name})`, `${type}(${name})`, next);
      }
      this.diverge("OPERATION_ADDED", this.peekExpected(), `${type}(${name})`, null);
    }
    this.consumed.add(`${name}:${occurrence}`);
    if (step!.type !== type && step!.type !== "step" && type !== "step") {
      this.diverge("OPERATION_CHANGED", `${step!.type}(${step!.name})`, `${type}(${name})`, step!);
    }
    if (input !== undefined && step!.input !== undefined && step!.input !== null && !jsonEqual(step!.input, input)) {
      this.diverge("INPUT_CHANGED", `${type}(${name}) input`, `${type}(${name}) input`, step!);
    }
    if (step!.status === "COMPLETED") {
      return step!.output;
    }
    if (step!.status === "FAILED") {
      throw new Error(step!.error?.message ?? "recorded operation failed");
    }
    if (step!.status !== "WAITING" && step!.status !== "PENDING" && step!.status !== "RUNNING") {
      this.diverge("INCOMPATIBLE_STATE", `${step!.status}`, step!.status, step!);
    }
    throw new WorkflowSuspend({ type: step!.type === "timer" ? "timer" : step!.type === "human" ? "human" : "join", ref: step!.id });
  }

  private peekExpected(): string {
    const next = this.bundle.steps.find((step) => !this.consumed.has(`${step.name}:${step.occurrence}`));
    return next ? `${next.type}(${next.name})` : "(end of history)";
  }

  private diverge(kind: ReplayDivergence["kind"], expected: string, actual: string, step: StepRun | null): never {
    const seq = this.bundle.history.find((event) => {
      const payload = event.payload as { name?: string };
      return payload.name === step?.name;
    })?.seq ?? null;
    throw new ReplayDivergenceError({
      kind,
      executionId: this.runId,
      workflowName: this.workflowName,
      recordedVersion: this.bundle.execution.workflowVersion,
      testedVersion: this.testedVersion,
      historySequence: seq,
      expected,
      actual,
      reason: kind.replaceAll("_", " ").toLowerCase(),
    });
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return left === right;
  }
}

export function emptyDeterministic(): DeterministicValue[] {
  return [];
}

export function nextUuid(): string {
  return randomUUID();
}

export type { AgentTaskOptions, ChildExecutionOptions, RemoteAgent };
