import { CancellationError, ChildWorkflowError, TimeoutError, WorkflowSuspend, serializeError, toError } from "../core/errors.ts";
import { isDurationString, parseDuration } from "../core/duration.ts";
import { OccurrenceCounter, operationIdentity } from "../core/identity.ts";
import { computeBackoffMs, normalizeRetry, shouldRetry } from "../core/retry.ts";
import { toJson } from "../core/serialize.ts";
import type { Clock, HumanOptions, StepOptions, StepRun, StepType, WorkflowRun } from "../core/types.ts";
import type { Store } from "../persistence/store.ts";
import type {
  AgentDefinition,
  AgentProvider,
  WorkflowContext,
  WorkflowDefinition,
} from "../sdk/types.ts";
import { executeAgent } from "./agent-runner.ts";
import type { McpManager } from "./mcp.ts";
import type { WorkNotifier } from "./notifier.ts";
import type { Logger } from "./logger.ts";
import type { WorkflowRegistry } from "./registry.ts";

export interface DurableContextOptions {
  store: Store;
  run: WorkflowRun;
  clock: Clock;
  logger: Logger;
  abortSignal: AbortSignal;
  notifier: WorkNotifier;
  defaultAgentProvider?: AgentProvider;
  mcp?: McpManager;
  registry?: WorkflowRegistry;
  maxChildDepth?: number;
}

export class DurableContext<TInput = unknown> implements WorkflowContext<TInput> {
  readonly input: TInput;
  readonly runId: string;
  readonly workflowName: string;
  readonly abortSignal: AbortSignal;
  readonly agent: WorkflowContext<TInput>["agent"];
  readonly human: WorkflowContext<TInput>["human"];
  readonly workflow: WorkflowContext<TInput>["workflow"];
  private readonly occurrences = new OccurrenceCounter();

  constructor(private readonly options: DurableContextOptions) {
    this.input = options.run.input as TInput;
    this.runId = options.run.id;
    this.workflowName = options.run.workflowName;
    this.abortSignal = options.abortSignal;
    const agentFn = this.runAgentStep.bind(this) as WorkflowContext<TInput>["agent"];
    agentFn.run = this.agentRun.bind(this);
    this.agent = agentFn;
    const humanFn = this.humanStep.bind(this) as WorkflowContext<TInput>["human"];
    humanFn.approve = (opts) => this.humanStep("approve", opts);
    this.human = humanFn;
    this.workflow = { run: this.childWorkflow.bind(this) };
  }

  async step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  async step<T>(name: string, options: StepOptions, fn: () => Promise<T> | T): Promise<T>;
  async step<T>(
    name: string,
    optionsOrFn: StepOptions | (() => Promise<T> | T),
    maybeFn?: () => Promise<T> | T,
  ): Promise<T> {
    const options: StepOptions = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (!fn) {
      throw new Error(`Step "${name}" is missing an execute function`);
    }
    return this.executeDurable(name, "step", options, fn);
  }

  async runAgentStep<T = unknown>(
    name: string,
    options: {
      agent: AgentDefinition;
      input?: unknown;
      prompt?: string;
      retry?: StepOptions["retry"];
      timeout?: StepOptions["timeout"];
    },
  ): Promise<T> {
    const input = options.prompt ?? options.input;
    return this.executeDurable(
      name,
      "agent",
      { retry: options.retry ?? options.agent.retry, timeout: options.timeout ?? options.agent.limits?.timeout, input: toJson(input) },
      async () => {
        const step = await this.currentStep(name);
        if (!step) {
          throw new Error(`Agent step "${name}" was not created`);
        }
        await this.options.store.appendHistory({
          runId: this.runId,
          type: "agent.started",
          payload: { name, stepId: step.id, agent: options.agent.name },
        });
        try {
          const output = await executeAgent({
            store: this.options.store,
            runId: this.runId,
            stepRunId: step.id,
            agent: options.agent,
            input,
            defaultProvider: this.options.defaultAgentProvider,
            abortSignal: this.abortSignal,
            mcp: this.options.mcp,
          });
          await this.options.store.appendHistory({
            runId: this.runId,
            type: "agent.completed",
            payload: { name, stepId: step.id },
          });
          return output as T;
        } catch (error) {
          await this.options.store.appendHistory({
            runId: this.runId,
            type: "agent.failed",
            payload: { name, stepId: step.id, error: serializeError(error) },
          });
          throw error;
        }
      },
    );
  }

  async agentRun<T = unknown>(
    agent: AgentDefinition,
    options: { prompt?: string; input?: unknown; name?: string } = {},
  ): Promise<T> {
    return this.runAgentStep(options.name ?? agent.name, {
      agent,
      input: options.input,
      prompt: options.prompt,
    });
  }

  async humanStep<T = unknown>(name: string, options: HumanOptions = {}): Promise<T> {
    await this.throwIfCancelled();
    const occurrence = this.occurrences.next(name);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      return existing.output as T;
    }
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type: "human",
        input: options.data ?? null,
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
      }));
    const task =
      (await this.options.store.getHumanTaskByStep(step.id)) ??
      (await this.options.store.createHumanTask({
        runId: this.runId,
        stepRunId: step.id,
        name,
        occurrence,
        title: options.title ?? name,
        assignedTo: options.assignedTo ?? null,
        data: options.data ?? null,
      }));
    if (!existing) {
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "human.created",
        payload: { name, taskId: task.id, stepId: step.id, assignedTo: task.assignedTo },
      });
    }
    if (task.status === "completed") {
      await this.options.store.updateStep(step.id, {
        status: "COMPLETED",
        output: task.response,
        completedAt: this.nowIso(),
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "human.completed",
        payload: { name, taskId: task.id },
      });
      return task.response as T;
    }
    throw new WorkflowSuspend({ type: "human", ref: task.id });
  }

  async sleep(duration: string | number): Promise<void>;
  async sleep(name: string, duration: string | number): Promise<void>;
  async sleep(nameOrDuration: string | number, maybeDuration?: string | number): Promise<void> {
    await this.throwIfCancelled();
    let name = "__sleep";
    let duration: string | number;
    if (maybeDuration !== undefined) {
      name = String(nameOrDuration);
      duration = maybeDuration;
    } else if (typeof nameOrDuration === "string" && !isDurationString(nameOrDuration) && typeof nameOrDuration !== "number") {
      throw new Error(`ctx.sleep expected a duration like "10s", received "${nameOrDuration}"`);
    } else {
      duration = nameOrDuration;
    }
    const occurrence = this.occurrences.next(name);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      return;
    }
    const ms = parseDuration(duration);
    const fireAt = new Date(this.options.clock.now().getTime() + ms);
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type: "timer",
        input: toJson({ duration: String(duration), fireAt: fireAt.toISOString() }),
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
      }));
    const timer =
      (await this.options.store.getTimerByStep(step.id)) ??
      (await this.options.store.createTimer({
        runId: this.runId,
        stepRunId: step.id,
        fireAt,
      }));
    if (!existing) {
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "timer.created",
        payload: { name, timerId: timer.id, fireAt: timer.fireAt },
      });
    }
    if (timer.status === "fired" || new Date(timer.fireAt).getTime() <= this.options.clock.now().getTime()) {
      const fired = timer.status === "fired" ? timer : await this.options.store.fireTimer(timer.id);
      if (fired) {
        await this.options.store.appendHistory({
          runId: this.runId,
          type: "timer.fired",
          payload: { name, timerId: fired.id },
        });
      }
      await this.options.store.updateStep(step.id, {
        status: "COMPLETED",
        output: toJson({ firedAt: this.nowIso() }),
        completedAt: this.nowIso(),
      });
      return;
    }
    if (!existing) {
      await this.options.store.enqueueWork({
        runId: this.runId,
        type: "execute_run",
        availableAt: timer.fireAt,
      });
      this.options.notifier.ping();
    }
    throw new WorkflowSuspend({ type: "timer", ref: timer.id });
  }

  async waitForEvent<T = unknown>(type: string): Promise<T> {
    await this.throwIfCancelled();
    const name = `event:${type}`;
    const occurrence = this.occurrences.next(name);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      return existing.output as T;
    }
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type: "event",
        input: toJson({ type }),
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
      }));
    const event = await this.options.store.findUnconsumedEvent(this.runId, type);
    if (event) {
      const consumed = await this.options.store.consumeEvent(event.id, step.id);
      await this.options.store.updateStep(step.id, {
        status: "COMPLETED",
        output: consumed?.data ?? event.data,
        completedAt: this.nowIso(),
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "event.consumed",
        payload: { type, eventId: event.id, stepId: step.id },
      });
      return (consumed?.data ?? event.data) as T;
    }
    throw new WorkflowSuspend({ type: "event", ref: type });
  }

  async parallel<const T extends ReadonlyArray<() => Promise<unknown>>>(
    fns: T,
  ): Promise<{ [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never }> {
    const settled = await Promise.allSettled(fns.map((fn) => fn()));
    const suspends: WorkflowSuspend[] = [];
    const values: unknown[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        values.push(result.value);
        continue;
      }
      if (result.reason instanceof WorkflowSuspend) {
        suspends.push(result.reason);
        continue;
      }
      throw result.reason;
    }
    if (suspends.length > 0) {
      throw new WorkflowSuspend(suspends.flatMap((item) => item.waits));
    }
    return values as { [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never };
  }

  async childWorkflow<T = unknown>(
    definition: WorkflowDefinition,
    input?: unknown,
    options: { name?: string; cancelChildren?: boolean } = {},
  ): Promise<T> {
    await this.throwIfCancelled();
    const name = options.name ?? `child:${definition.name}`;
    const occurrence = this.occurrences.next(name);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      return existing.output as T;
    }
    const maxDepth = this.options.maxChildDepth ?? 8;
    const depth = this.options.run.childDepth + 1;
    if (depth > maxDepth) {
      throw new ChildWorkflowError("", `Child workflow nesting exceeded ${maxDepth}`);
    }
    this.options.registry?.register(definition);
    await this.options.store.registerWorkflow(definition.name, definition.version);
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type: "child",
        input: toJson(input ?? {}),
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
      }));
    let child = await this.options.store.getChildByStep(step.id);
    if (!child) {
      child = await this.options.store.createRun({
        workflowName: definition.name,
        workflowVersion: definition.version,
        input: input ?? {},
        parentRunId: this.runId,
        parentStepId: step.id,
        childDepth: depth,
        cancelOnParentCancel: options.cancelChildren !== false,
      });
      await this.options.store.enqueueWork({ runId: child.id, type: "execute_run" });
      this.options.notifier.ping();
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "child.started",
        payload: { childRunId: child.id, workflow: definition.name, version: definition.version, stepId: step.id },
      });
    }
    if (child.status === "COMPLETED") {
      await this.options.store.updateStep(step.id, {
        status: "COMPLETED",
        output: child.output,
        completedAt: this.nowIso(),
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "child.completed",
        payload: { childRunId: child.id },
      });
      return child.output as T;
    }
    if (child.status === "FAILED" || child.status === "CANCELLED") {
      await this.options.store.updateStep(step.id, {
        status: "FAILED",
        error: child.error,
        completedAt: this.nowIso(),
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: child.status === "CANCELLED" ? "child.cancelled" : "child.failed",
        payload: { childRunId: child.id, error: child.error },
      });
      throw new ChildWorkflowError(child.id, child.error?.message ?? `Child workflow ${child.id} ${child.status.toLowerCase()}`);
    }
    throw new WorkflowSuspend({ type: "child", ref: child.id });
  }

  private currentStepName: string | null = null;

  private async currentStep(name: string): Promise<StepRun | null> {
    const occurrence = this.occurrences.peek(name) - 1;
    if (occurrence < 0) {
      return null;
    }
    return this.options.store.getStepByIdentity(this.runId, name, occurrence);
  }

  private async executeDurable<T>(
    name: string,
    type: StepType,
    options: StepOptions,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    await this.throwIfCancelled();
    const occurrence = this.occurrences.next(name);
    const retry = normalizeRetry(options.retry);
    const timeoutMs = options.timeout !== undefined ? parseDuration(options.timeout) : null;
    const identity = operationIdentity(this.runId, name, occurrence);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      return existing.output as T;
    }
    if (existing?.status === "FAILED" && existing.attempt >= existing.maxAttempts) {
      throw restoreError(existing);
    }

    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type,
        input: options.input ?? null,
        status: "PENDING",
        attempt: 0,
        maxAttempts: retry.maxAttempts,
        timeoutMs,
        idempotencyKey: options.idempotencyKey ?? null,
      }));

    const attempt = (existing?.attempt ?? 0) + 1;
    this.currentStepName = name;
    await this.options.store.updateStep(step.id, {
      status: "RUNNING",
      attempt,
      startedAt: step.startedAt ?? this.nowIso(),
    });
    if (attempt === 1) {
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "step.scheduled",
        payload: { name, stepId: step.id, type, operationId: identity },
      });
    }
    await this.options.store.appendHistory({
      runId: this.runId,
      type: attempt > 1 ? "step.retrying" : "step.started",
      payload: { name, stepId: step.id, attempt, operationId: identity },
    });
    this.options.logger.info(
      { runId: this.runId, stepId: step.id, name, attempt, type },
      attempt > 1 ? "retrying durable operation" : "starting durable operation",
    );

    try {
      const output = await withTimeout(fn, timeoutMs, this.abortSignal);
      const json = toJson(output);
      await this.options.store.updateStep(step.id, {
        status: "COMPLETED",
        output: json,
        completedAt: this.nowIso(),
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "step.completed",
        payload: { name, stepId: step.id, attempt, durationMs: durationSince(step.startedAt ?? this.nowIso(), this.nowIso()) },
      });
      return output;
    } catch (error) {
      if (error instanceof WorkflowSuspend) {
        throw error;
      }
      const persisted = serializeError(error, { attempt, operationId: identity });
      const retryable = shouldRetry(retry, attempt) && !(error instanceof CancellationError);
      await this.options.store.updateStep(step.id, {
        status: retryable ? "RETRYING" : "FAILED",
        error: persisted,
        completedAt: retryable ? null : this.nowIso(),
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: retryable ? "step.retrying" : "step.failed",
        payload: { name, stepId: step.id, attempt, error: persisted },
      });
      this.options.logger.warn(
        { runId: this.runId, stepId: step.id, name, attempt, err: toError(error) },
        retryable ? "durable operation failed; will retry" : "durable operation failed",
      );
      if (!retryable) {
        throw error;
      }
      const delay = computeBackoffMs(retry, attempt);
      await this.options.store.enqueueWork({
        runId: this.runId,
        type: "execute_run",
        availableAt: new Date(this.options.clock.now().getTime() + delay),
      });
      this.options.notifier.ping();
      throw new WorkflowSuspend({ type: "retry", ref: step.id });
    } finally {
      this.currentStepName = null;
    }
  }

  private async throwIfCancelled(): Promise<void> {
    if (this.abortSignal.aborted) {
      throw new CancellationError();
    }
    const run = await this.options.store.getRun(this.runId);
    if (run?.status === "CANCELLED") {
      throw new CancellationError();
    }
  }

  private nowIso(): string {
    return this.options.clock.now().toISOString();
  }
}

function durationSince(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}

function restoreError(step: StepRun): Error {
  const error = new Error(step.error?.message ?? "Durable operation failed");
  error.name = step.error?.name ?? "Error";
  return error;
}

async function withTimeout<T>(
  fn: () => Promise<T> | T,
  timeoutMs: number | null,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new CancellationError();
  }
  const result = fn();
  if (timeoutMs === null && !signal) {
    return result;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new CancellationError());
    };
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (timer) {
        clearTimeout(timer);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    Promise.resolve(result).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
