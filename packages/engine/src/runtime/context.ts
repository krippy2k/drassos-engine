import { randomUUID } from "node:crypto";
import {
  CancellationError,
  ChildExecutionCancelledError,
  ChildExecutionFailedError,
  ChildExecutionTimeoutError,
  ChildWorkflowError,
  ExecutionDepthExceededError,
  ExecutionLimitExceededError,
  TaskPayloadTooLargeError,
  TimeoutError,
  UnknownAgentError,
  UnknownWorkflowError,
  WorkflowSuspend,
  serializeError,
  toError,
} from "../core/errors.ts";
import { isDurationString, parseDuration } from "../core/duration.ts";
import { OccurrenceCounter, operationIdentity } from "../core/identity.ts";
import { computeBackoffMs, normalizeRetry, shouldRetry } from "../core/retry.ts";
import { assertSerializable, toJson } from "../core/serialize.ts";
import type {
  ApprovalOptions,
  ChildExecutionOptions,
  Clock,
  DelegationPlan,
  ExecutionHandle,
  ExecutionStatus,
  HumanDecision,
  HumanOptions,
  OrchestrationLimits,
  SignalOptions,
  SignalWaitResult,
  StepOptions,
  StepRun,
  StepType,
  WorkItemType,
  WorkflowRun,
} from "../core/types.ts";
import { DEFAULT_ORCHESTRATION_LIMITS, DEFAULT_TASK_QUEUE } from "../core/types.ts";
import { MAX_TASK_PAYLOAD_BYTES, payloadSizeBytes } from "../worker/protocol.ts";
import type { Store } from "../persistence/store.ts";
import type {
  AgentDefinition,
  AgentProvider,
  AgentTaskOptions,
  ToolDefinition,
  WorkflowContext,
  WorkflowDefinition,
} from "../sdk/types.ts";
import { assertSignalName, humanSignalName, parseHumanDecision } from "../sdk/signals.ts";
import { executeAgent } from "./agent-runner.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { planWaves, validateDelegationPlan } from "./delegation.ts";
import { isMcpToolRef, mcpToolCapability, type McpManager } from "./mcp.ts";
import { isRemoteAgent, type RemoteAgent } from "./a2a.ts";
import type { WorkNotifier } from "./notifier.ts";
import type { Logger } from "./logger.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { ModelRegistry } from "../models/model-registry.ts";
import type { ToolRegistry } from "../tools/tool-registry.ts";
import { isPermanentInteropError } from "../capabilities/retry.ts";
import { executeRemoteCapability } from "../capabilities/invoke.ts";
import { localToolCapability } from "../capabilities/local.ts";
import type { AuthProvider } from "../capabilities/auth.ts";
import type { Capability } from "../capabilities/types.ts";

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
  models?: ModelRegistry;
  toolRegistry?: ToolRegistry;
  agentRegistry?: AgentRegistry;
  authProvider?: AuthProvider;
  maxChildDepth?: number;
  orchestrationLimits?: OrchestrationLimits;
  cancelExecution?: (executionId: string, reason?: string) => Promise<unknown>;
  getExecutionStatus?: (executionId: string) => Promise<ExecutionStatus>;
  deterministicValues?: Array<{ kind: string; occurrence: number; value: unknown }>;
}

export class DurableContext<TInput = unknown> implements WorkflowContext<TInput> {
  readonly input: TInput;
  readonly runId: string;
  readonly workflowName: string;
  readonly abortSignal: AbortSignal;
  readonly agent: WorkflowContext<TInput>["agent"];
  readonly human: WorkflowContext<TInput>["human"];
  readonly workflow: WorkflowContext<TInput>["workflow"];
  readonly tool: WorkflowContext<TInput>["tool"];
  private readonly occurrences = new OccurrenceCounter();
  private readonly clocks = new OccurrenceCounter();
  private readonly clockValues = new Map<string, unknown>();
  private pendingWrites: Array<Promise<void>> = [];

  constructor(private readonly options: DurableContextOptions) {
    this.input = options.run.input as TInput;
    this.runId = options.run.id;
    this.workflowName = options.run.workflowName;
    this.abortSignal = options.abortSignal;
    const agentFn = this.dispatchAgent.bind(this) as WorkflowContext<TInput>["agent"];
    agentFn.run = this.agentRun.bind(this);
    this.agent = agentFn;
    this.tool = (target) => ({
      run: (input?: unknown) => this.invokeTool(target, input),
    });
    const humanFn = this.humanStep.bind(this) as WorkflowContext<TInput>["human"];
    humanFn.approve = (opts) => this.humanStep("approve", opts);
    this.human = humanFn;
    const workflowFn = this.invokeNamedWorkflow.bind(this) as WorkflowContext<TInput>["workflow"];
    workflowFn.run = this.childWorkflow.bind(this);
    this.workflow = workflowFn;
    for (const item of options.deterministicValues ?? []) {
      this.clockValues.set(`${item.kind}:${item.occurrence}`, item.value);
    }
  }

  now(): Date {
    return new Date(String(this.recordClock("now", () => this.options.clock.now().toISOString())));
  }

  random(): number {
    return Number(this.recordClock("random", () => Math.random()));
  }

  uuid(): string {
    return String(this.recordClock("uuid", () => randomUUID()));
  }

  async flushDeterministic(): Promise<void> {
    await Promise.all(this.pendingWrites);
    this.pendingWrites = [];
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

  async activity<T = unknown>(name: string, input?: unknown, options?: StepOptions): Promise<T> {
    return this.dispatchDistributed({
      name,
      type: "activity",
      queue: options?.queue ?? DEFAULT_TASK_QUEUE,
      input,
      options,
    });
  }

  dispatchAgent(
    nameOrAgent: string | AgentDefinition | RemoteAgent,
    optionsOrInput?: unknown,
    maybeOptions?: ChildExecutionOptions,
  ) {
    if (typeof nameOrAgent !== "string") {
      return {
        run: (input?: unknown) => this.runBoundAgent(nameOrAgent, input),
      };
    }
    return this.runAgentStep(nameOrAgent, optionsOrInput, maybeOptions);
  }

  async runBoundAgent<T = unknown>(target: AgentDefinition | RemoteAgent, input?: unknown): Promise<T> {
    if (isRemoteAgent(target)) {
      return this.invokeCapability(target.capability, input ?? {}, `a2a:${target.name}`, target.timeout);
    }
    return this.agentRun(target, { input: input ?? {} });
  }

  async invokeTool<T = unknown>(
    target: ToolDefinition | { kind?: string; name: string } | Capability,
    input?: unknown,
  ): Promise<T> {
    const capability = toCapability(target, this.options.mcp, this.options.authProvider);
    return this.invokeCapability(capability, input ?? {}, `tool:${capability.name}`, capability.timeout);
  }

  async invokeCapability<T = unknown>(
    capability: Capability,
    input: unknown,
    stepName: string,
    timeout?: string | number,
  ): Promise<T> {
    return this.executeDurable(stepName, capability.kind === "agent" ? "agent" : "step", { timeout, retry: capability.retry }, async () => {
      const step = await this.currentStep(stepName);
      return executeRemoteCapability({
        store: this.options.store,
        runId: this.runId,
        stepRunId: step?.id ?? null,
        capability,
        input: assertSerializable(input ?? {}, `${stepName} input`),
        abortSignal: this.abortSignal,
        timeoutMs: timeout !== undefined ? parseDuration(timeout) : null,
        logger: this.options.logger,
        notifier: this.options.notifier,
      }) as Promise<T>;
    });
  }

  async runAgentStep<T = unknown>(
    name: string,
    optionsOrInput?: unknown,
    maybeOptions?: ChildExecutionOptions,
  ): Promise<T> {
    if (isInlineAgentOptions(optionsOrInput)) {
      return this.runInlineAgentTask(name, optionsOrInput);
    }
    if (isWrappedAgentOptions(optionsOrInput)) {
      const input = optionsOrInput.prompt ?? optionsOrInput.input;
      const childOptions = { ...extractChildOptions(optionsOrInput), ...maybeOptions };
      return this.executeAgentChild(name, optionsOrInput.agent, input, childOptions);
    }
    const childOptions = { ...extractChildOptions(optionsOrInput), ...maybeOptions, name: maybeOptions?.name ?? name };
    return this.invokeNamedAgent(name, optionsOrInput ?? {}, childOptions);
  }

  async runInlineAgentTask<T = unknown>(name: string, options: AgentTaskOptions): Promise<T> {
    if (options.tools?.length) {
      if (!this.options.toolRegistry) {
        throw new Error(`Tool "${options.tools[0]}" is not registered`);
      }
      this.options.toolRegistry.authorize(options.tools);
    }
    const agent: AgentDefinition = {
      name,
      instructions: options.prompt,
      model: options.model,
      allowedToolNames: options.tools,
      output: options.output,
      limits: {
        maxTurns: options.maxTurns,
        maxToolCalls: options.maxToolCalls,
        timeout: options.timeout,
      },
    };
    return this.runAgentStep(name, {
      agent,
      prompt: options.prompt,
      input: options.input,
      timeout: options.timeout,
    });
  }

  async agentRun<T = unknown>(
    agent: AgentDefinition,
    options: { prompt?: string; input?: unknown; name?: string } & ChildExecutionOptions = {},
  ): Promise<T> {
    return this.runAgentStep(options.name ?? agent.name, {
      agent,
      input: options.input,
      prompt: options.prompt,
      retry: options.retry,
      timeout: options.timeout,
      cancellation: options.cancellation,
      onFailure: options.onFailure,
    });
  }

  async invokeNamedAgent<T = unknown>(
    name: string,
    input: unknown = {},
    options: ChildExecutionOptions = {},
  ): Promise<T> {
    const registered = this.options.agentRegistry;
    if (!registered?.has(name)) {
      if (!registered || registered.list().length === 0) {
        throw new Error(`Agent task "${options.name ?? name}" requires an agent definition or model`);
      }
      throw new UnknownAgentError(name);
    }
    return this.executeAgentChild(options.name ?? name, registered.get(name), input, options);
  }

  async executeAgentChild<T = unknown>(
    name: string,
    agent: AgentDefinition,
    input: unknown,
    options: ChildExecutionOptions = {},
  ): Promise<T> {
    const payload = assertSerializable(input ?? {}, `agent ${name} input`);
    if (options.queue) {
      return this.dispatchDistributed({
        name,
        type: "agent",
        queue: options.queue,
        input: payload,
        options: { retry: options.retry, timeout: options.timeout },
        payloadExtra: { agentName: agent.name },
      });
    }
    try {
      return await this.executeDurable(
        name,
        "agent",
        {
          retry: options.retry ?? agent.retry,
          timeout: options.timeout ?? agent.limits?.timeout,
          input: payload,
        },
        async () => {
          const step = await this.currentStep(name);
          if (!step) {
            throw new Error(`Agent step "${name}" was not created`);
          }
          const parent = this.options.run;
          const depth = parent.childDepth + 1;
          const existingAgent = await this.options.store.getAgentRunByStep(step.id);
          if (!existingAgent) {
            await this.assertCanCreateChild("agent");
          }
          await this.options.store.appendHistory({
            runId: this.runId,
            type: "agent.started",
            payload: { name, stepId: step.id, agent: agent.name },
          });
          await this.options.store.appendHistory({
            runId: this.runId,
            type: "delegation.requested",
            payload: { type: "agent", target: agent.name, stepId: step.id },
          });
          try {
            const output = await executeAgent({
              store: this.options.store,
              runId: this.runId,
              stepRunId: step.id,
              agent,
              input,
              defaultProvider: this.options.defaultAgentProvider,
              abortSignal: this.abortSignal,
              mcp: this.options.mcp,
              models: this.options.models,
              toolRegistry: this.options.toolRegistry,
              agentRegistry: this.options.agentRegistry,
              parentExecutionId: parent.id,
              rootExecutionId: parent.rootRunId || parent.id,
              depth,
              failurePolicy: options.onFailure ?? "fail-parent",
              cancellationPolicy: options.cancellation ?? "propagate",
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
    } catch (error) {
      if (error instanceof WorkflowSuspend) {
        throw error;
      }
      if ((options.onFailure ?? "fail-parent") === "return-error") {
        const step = await this.currentStep(name);
        const agentRun = step ? await this.options.store.getAgentRunByStep(step.id) : null;
        return this.applyFailurePolicy("return-error", agentRun?.id ?? "", error instanceof Error ? error : toError(error)) as T;
      }
      throw error;
    }
  }

  async invokeNamedWorkflow<T = unknown>(
    name: string,
    input?: unknown,
    options: ChildExecutionOptions = {},
  ): Promise<T> {
    if (!this.options.registry?.has(name)) {
      throw new UnknownWorkflowError(name);
    }
    const definition = this.options.registry.get(name);
    return this.childWorkflow(definition, input, {
      ...options,
      name: options.name ?? `workflow:${name}`,
      cancelChildren: options.cancellation !== "detach",
    });
  }

  async startWorkflow<T = unknown>(
    name: string,
    input?: unknown,
    options: ChildExecutionOptions = {},
  ): Promise<ExecutionHandle<T>> {
    if (!this.options.registry?.has(name)) {
      throw new UnknownWorkflowError(name);
    }
    const definition = this.options.registry.get(name);
    const child = await this.ensureChildRun(definition, input, {
      ...options,
      name: options.name ?? `start:${name}`,
      cancelChildren: options.cancellation !== "detach",
    });
    const step = await this.currentStep(options.name ?? `start:${name}`);
    if (step && step.status !== "COMPLETED") {
      await this.options.store.updateStep(step.id, {
        status: "COMPLETED",
        output: { executionId: child.id },
        completedAt: this.nowIso(),
      });
    }
    return this.makeHandle<T>(child.id);
  }

  async map<T, R>(
    items: T[],
    callback: (item: T, index: number) => Promise<R>,
    options: { concurrency?: number; name?: string } = {},
  ): Promise<R[]> {
    assertSerializable(items, options.name ? `${options.name} items` : "map items");
    const limits = this.limits();
    if (options.concurrency !== undefined && options.concurrency < 1) {
      throw new ExecutionLimitExceededError("maxConcurrentChildren", "concurrency must be at least 1");
    }
    if (options.concurrency !== undefined && options.concurrency > limits.maxConcurrentChildren) {
      throw new ExecutionLimitExceededError(
        "maxConcurrentChildren",
        `Requested concurrency ${options.concurrency} exceeds maxConcurrentChildren ${limits.maxConcurrentChildren}`,
      );
    }
    const concurrency = Math.max(
      1,
      Math.min(options.concurrency ?? items.length, limits.maxConcurrentChildren, Math.max(items.length, 1)),
    );
    const results: R[] = [];
    for (let offset = 0; offset < items.length; offset += concurrency) {
      const batch = items.slice(offset, offset + concurrency);
      const batchResults = await this.parallel(
        batch.map((item, index) => () => callback(item, offset + index)),
      );
      results.push(...(batchResults as R[]));
    }
    return results;
  }

  async executePlan(
    plan: DelegationPlan,
    options: { concurrency?: number } & ChildExecutionOptions = {},
  ): Promise<Record<string, unknown>> {
    const tasks = validateDelegationPlan(plan, {
      workflows: this.options.registry,
      agents: this.options.agentRegistry,
      limits: this.limits(),
      currentDepth: this.options.run.childDepth,
    });
    await this.options.store.appendHistory({
      runId: this.runId,
      type: "delegation.accepted",
      payload: { tasks: tasks.map((task) => ({ id: task.id, type: task.type, target: task.target })) },
    });
    const results: Record<string, unknown> = {};
    for (const wave of planWaves(tasks)) {
      const outputs = await this.map(
        wave,
        async (task) => {
          const input =
            task.dependsOn && task.dependsOn.length > 0
              ? { ...(isRecord(task.input) ? task.input : { value: task.input ?? null }), dependencies: Object.fromEntries(task.dependsOn.map((id) => [id, results[id]])) }
              : (task.input ?? {});
          if (task.type === "workflow") {
            return {
              id: task.id,
              output: await this.invokeNamedWorkflow(task.target, input, {
                ...options,
                name: `plan:${task.id}`,
              }),
            };
          }
          return {
            id: task.id,
            output: await this.invokeNamedAgent(task.target, input, {
              ...options,
              name: `plan:${task.id}`,
            }),
          };
        },
        { concurrency: options.concurrency, name: "plan" },
      );
      for (const item of outputs) {
        results[item.id] = item.output;
      }
    }
    return results;
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

  async waitForSignal<T = unknown>(name: string): Promise<T>;
  async waitForSignal<T = unknown>(
    name: string,
    options: SignalOptions & { timeout: string | number },
  ): Promise<SignalWaitResult<T>>;
  async waitForSignal<T = unknown>(name: string, options?: SignalOptions): Promise<T | SignalWaitResult<T>>;
  async waitForSignal<T = unknown>(name: string, options?: SignalOptions): Promise<T | SignalWaitResult<T>> {
    const signalName = assertSignalName(name);
    const wrapped = await this.awaitSignal(signalName, `signal:${signalName}`, "signal", options?.timeout);
    if (options?.timeout !== undefined) {
      return wrapped as SignalWaitResult<T>;
    }
    if (wrapped.timedOut) {
      throw new TimeoutError(`Timed out waiting for signal "${signalName}"`);
    }
    return wrapped.payload as T;
  }

  async approval<T = unknown>(options: ApprovalOptions): Promise<HumanDecision<T>> {
    await this.throwIfCancelled();
    if (!options.id?.trim()) {
      throw new Error("approval requires an id");
    }
    const interactionId = options.id.trim();
    const name = `approval:${interactionId}`;
    const occurrence = this.occurrences.next(name);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      return existing.output as HumanDecision<T>;
    }
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type: "human",
        input: toJson({
          id: interactionId,
          title: options.title,
          description: options.description ?? null,
        }),
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
        timeoutMs: options.timeout !== undefined ? parseDuration(options.timeout) : null,
      }));
    let interaction =
      (await this.options.store.getInteractionByStep(step.id)) ??
      (await this.options.store.createInteraction({
        runId: this.runId,
        stepRunId: step.id,
        interactionId,
        type: "approval",
        title: options.title,
        description: options.description ?? null,
        metadata: options.metadata ?? null,
      }));
    if (!existing) {
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "human.interaction.created",
        payload: {
          interactionId,
          recordId: interaction.id,
          title: options.title,
          stepId: step.id,
        },
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "signal.wait.started",
        payload: { name: humanSignalName(interactionId), stepId: step.id, timeout: options.timeout ?? null },
      });
    }
    interaction = (await this.options.store.getInteractionByStep(step.id)) ?? interaction;
    if (interaction.status !== "pending" && interaction.decision) {
      await this.finishStep(step.id, name, interaction.decision);
      return interaction.decision as HumanDecision<T>;
    }
    const result = await this.awaitSignal(
      humanSignalName(interactionId),
      name,
      "human",
      options.timeout,
      step,
      interactionId,
      false,
    );
    if (!result.timedOut) {
      const decision = parseHumanDecision(result.payload);
      await this.finishStep(step.id, name, decision);
      return decision as HumanDecision<T>;
    }
    const timedOut = await this.options.store.completeInteraction(interaction.id, "timed_out", {
      outcome: "timed_out",
    });
    if (timedOut) {
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "human.interaction.timed_out",
        payload: { interactionId, recordId: interaction.id },
      });
      const decision: HumanDecision = { outcome: "timed_out" };
      await this.finishStep(step.id, name, decision);
      return decision as HumanDecision<T>;
    }
    const latest = (await this.options.store.getInteractionByStep(step.id)) ?? interaction;
    const decision = latest.decision ?? parseHumanDecision(latest.decision);
    await this.finishStep(step.id, name, decision);
    return decision as HumanDecision<T>;
  }

  private async finishStep(stepId: string, name: string, output: unknown): Promise<void> {
    await this.options.store.updateStep(stepId, {
      status: "COMPLETED",
      output: toJson(output),
      completedAt: this.nowIso(),
    });
    await this.options.store.appendHistory({
      runId: this.runId,
      type: "step.completed",
      payload: { name, stepId },
    });
  }

  private async awaitSignal(
    signalName: string,
    stepName: string,
    waitType: "signal" | "human",
    timeout?: string | number,
    existingStep?: StepRun,
    waitRef?: string,
    persist = true,
  ): Promise<SignalWaitResult> {
    await this.throwIfCancelled();
    const occurrence = existingStep ? existingStep.occurrence : this.occurrences.next(stepName);
    const existing =
      existingStep ?? (await this.options.store.getStepByIdentity(this.runId, stepName, occurrence));
    if (existing?.status === "COMPLETED") {
      return existing.output as SignalWaitResult;
    }
    const timeoutMs = timeout !== undefined ? parseDuration(timeout) : null;
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name: stepName,
        occurrence,
        type: waitType === "human" ? "human" : "signal",
        input: toJson({ signal: signalName, timeout: timeout ?? null }),
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
        timeoutMs,
      }));
    if (!existing) {
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "signal.wait.started",
        payload: { name: signalName, stepId: step.id, timeout: timeout ?? null },
      });
    }
    let timer = timeoutMs !== null ? await this.options.store.getTimerByStep(step.id) : null;
    if (timeoutMs !== null && !timer) {
      const fireAt = new Date(this.options.clock.now().getTime() + timeoutMs);
      timer = await this.options.store.createTimer({
        runId: this.runId,
        stepRunId: step.id,
        fireAt,
      });
      await this.options.store.enqueueWork({
        runId: this.runId,
        type: "execute_run",
        availableAt: timer.fireAt,
      });
      this.options.notifier.ping();
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "timer.created",
        payload: { name: stepName, timerId: timer.id, fireAt: timer.fireAt },
      });
    }
    if (timer?.status === "pending" && new Date(timer.fireAt).getTime() <= this.options.clock.now().getTime()) {
      const fired = await this.options.store.fireTimer(timer.id);
      if (fired) {
        timer = fired;
        await this.options.store.appendHistory({
          runId: this.runId,
          type: "timer.fired",
          payload: { name: stepName, timerId: fired.id },
        });
      }
    } else if (timer?.status === "fired") {
      timer = timer;
    }
    const event = await this.options.store.findUnconsumedEvent(this.runId, signalName);
    const timerFired = timer?.status === "fired" || (timer != null && new Date(timer.fireAt).getTime() <= this.options.clock.now().getTime());
    let winner: "signal" | "timeout" | null = null;
    if (event && timerFired && timer) {
      const eventAt = new Date(event.receivedAt).getTime();
      const fireAt = new Date(timer.firedAt ?? timer.fireAt).getTime();
      winner = eventAt <= fireAt ? "signal" : "timeout";
    } else if (event) {
      winner = "signal";
    } else if (timerFired) {
      winner = "timeout";
    }
    if (winner === "signal" && event) {
      const consumed = await this.options.store.consumeEvent(event.id, step.id);
      if (timer?.status === "pending") {
        await this.options.store.cancelTimer(timer.id);
      }
      const payload = consumed?.data ?? event.data;
      const result: SignalWaitResult = { timedOut: false, payload };
      if (persist) {
        await this.options.store.updateStep(step.id, {
          status: "COMPLETED",
          output: toJson(result),
          completedAt: this.nowIso(),
        });
      }
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "signal.wait.completed",
        payload: { name: signalName, stepId: step.id, signalId: event.id },
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "event.consumed",
        payload: { type: signalName, eventId: event.id, stepId: step.id },
      });
      return result;
    }
    if (winner === "timeout") {
      const result: SignalWaitResult = { timedOut: true };
      if (persist) {
        await this.options.store.updateStep(step.id, {
          status: "COMPLETED",
          output: toJson(result),
          completedAt: this.nowIso(),
        });
      }
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "signal.wait.timed_out",
        payload: { name: signalName, stepId: step.id, timerId: timer?.id ?? null },
      });
      return result;
    }
    throw new WorkflowSuspend({ type: waitType, ref: waitRef ?? signalName });
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
    options: { name?: string; cancelChildren?: boolean } & ChildExecutionOptions = {},
  ): Promise<T> {
    const child = await this.ensureChildRun(definition, input, options);
    return this.awaitChildRun(child, {
      ...options,
      name: options.name ?? `child:${definition.name}`,
    });
  }

  private async ensureChildRun(
    definition: WorkflowDefinition,
    input: unknown,
    options: { name?: string; cancelChildren?: boolean } & ChildExecutionOptions,
  ): Promise<WorkflowRun> {
    await this.throwIfCancelled();
    const name = options.name ?? `child:${definition.name}`;
    const occurrence = this.occurrences.next(name);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      const completedChild = await this.options.store.getChildByStep(existing.id);
      if (completedChild) {
        return completedChild;
      }
      const executionId =
        existing.output && typeof existing.output === "object" && !Array.isArray(existing.output)
          ? String((existing.output as { executionId?: string }).executionId ?? "")
          : "";
      if (executionId) {
        const run = await this.options.store.getRun(executionId);
        if (run) {
          return run;
        }
      }
    }
    const payload = assertSerializable(input ?? {}, `child workflow ${definition.name} input`);
    const limits = this.limits();
    const depth = this.options.run.childDepth + 1;
    if (depth > limits.maxDepth) {
      if (!name.startsWith("child:")) {
        throw new ExecutionDepthExceededError(depth, limits.maxDepth);
      }
      throw new ChildWorkflowError("", `Child workflow nesting exceeded ${limits.maxDepth}`);
    }
    if (this.options.registry && !this.options.registry.has(definition.name, definition.version)) {
      this.options.registry.register(definition);
    }
    await this.options.store.registerWorkflow(definition.name, definition.version);
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type: "child",
        input: payload,
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
        timeoutMs: options.timeout !== undefined ? parseDuration(options.timeout) : null,
      }));
    let child = await this.options.store.getChildByStep(step.id);
    if (!child) {
      await this.assertCanCreateChild("workflow");
      const timeoutAt =
        options.timeout !== undefined
          ? new Date(this.options.clock.now().getTime() + parseDuration(options.timeout)).toISOString()
          : null;
      const parent = this.options.run;
      child = await this.options.store.createRun({
        workflowName: definition.name,
        workflowVersion: definition.version,
        input: input ?? {},
        parentRunId: this.runId,
        parentStepId: step.id,
        childDepth: depth,
        cancelOnParentCancel:
          options.cancellation === "detach" ? false : options.cancelChildren !== false,
        rootRunId: parent.rootRunId || parent.id,
        failurePolicy: options.onFailure ?? "fail-parent",
        cancellationPolicy: options.cancellation ?? "propagate",
        timeoutAt,
      });
      await this.options.store.enqueueWork({ runId: child.id, type: "execute_run" });
      this.options.notifier.ping();
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "child.started",
        payload: { childRunId: child.id, workflow: definition.name, version: definition.version, stepId: step.id },
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "child.created",
        payload: { childRunId: child.id, workflow: definition.name, stepId: step.id },
      });
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "execution.created",
        payload: { executionId: child.id, type: "workflow", parentExecutionId: this.runId },
      });
    }
    return child;
  }

  private async awaitChildRun<T>(
    child: WorkflowRun,
    options: ChildExecutionOptions & { name?: string } = {},
  ): Promise<T> {
    const latest = (await this.options.store.getRun(child.id)) ?? child;
    const step = latest.parentStepId
      ? ((await this.options.store.listSteps(this.runId)).find((item) => item.id === latest.parentStepId) ?? null)
      : null;
    if (step?.status === "COMPLETED") {
      return step.output as T;
    }
    if (latest.status === "COMPLETED") {
      if (step) {
        await this.options.store.updateStep(step.id, {
          status: "COMPLETED",
          output: latest.output,
          completedAt: this.nowIso(),
        });
      }
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "child.completed",
        payload: { childRunId: latest.id },
      });
      return latest.output as T;
    }
    if (latest.status === "FAILED" || latest.status === "CANCELLED") {
      if (step) {
        await this.options.store.updateStep(step.id, {
          status: "FAILED",
          error: latest.error,
          completedAt: this.nowIso(),
        });
      }
      await this.options.store.appendHistory({
        runId: this.runId,
        type: latest.status === "CANCELLED" ? "child.cancelled" : "child.failed",
        payload: { childRunId: latest.id, error: latest.error },
      });
      const error = childErrorFor(latest);
      if (options.name?.startsWith("child:")) {
        if (options.onFailure === "return-error") {
          return this.applyFailurePolicy("return-error", latest.id, error) as T;
        }
        throw new ChildWorkflowError(latest.id, error.message, error);
      }
      return this.applyFailurePolicy(options.onFailure ?? latest.failurePolicy ?? "fail-parent", latest.id, error) as T;
    }
    throw new WorkflowSuspend({ type: "child", ref: latest.id });
  }

  private makeHandle<T>(executionId: string): ExecutionHandle<T> {
    return {
      executionId,
      result: () => this.awaitExecution<T>(executionId),
      status: async () => {
        if (this.options.getExecutionStatus) {
          return this.options.getExecutionStatus(executionId);
        }
        const run = await this.options.store.getRun(executionId);
        if (!run) {
          throw new Error(`Execution not found: ${executionId}`);
        }
        return run.status;
      },
      cancel: async () => {
        await this.options.cancelExecution?.(executionId, "cancelled via handle");
      },
    };
  }

  private async awaitExecution<T>(executionId: string): Promise<T> {
    await this.throwIfCancelled();
    const name = `await:${executionId}`;
    const occurrence = this.occurrences.next(name);
    const existing = await this.options.store.getStepByIdentity(this.runId, name, occurrence);
    if (existing?.status === "COMPLETED") {
      return existing.output as T;
    }
    const child = await this.options.store.getRun(executionId);
    if (!child) {
      throw new ChildExecutionFailedError(executionId, `Child execution ${executionId} was not found`);
    }
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name,
        occurrence,
        type: "child",
        input: { executionId },
        status: "WAITING",
        attempt: 1,
        maxAttempts: 1,
      }));
    if (child.status === "COMPLETED") {
      await this.options.store.updateStep(step.id, {
        status: "COMPLETED",
        output: child.output,
        completedAt: this.nowIso(),
      });
      return child.output as T;
    }
    if (child.status === "FAILED" || child.status === "CANCELLED") {
      await this.options.store.updateStep(step.id, {
        status: "FAILED",
        error: child.error,
        completedAt: this.nowIso(),
      });
      const error = childErrorFor(child);
      return this.applyFailurePolicy(child.failurePolicy ?? "fail-parent", child.id, error) as T;
    }
    throw new WorkflowSuspend({ type: "child", ref: child.id });
  }

  private limits(): Required<OrchestrationLimits> {
    return {
      ...DEFAULT_ORCHESTRATION_LIMITS,
      ...this.options.orchestrationLimits,
      maxDepth: this.options.orchestrationLimits?.maxDepth ?? this.options.maxChildDepth ?? DEFAULT_ORCHESTRATION_LIMITS.maxDepth,
    };
  }

  private async assertCanCreateChild(kind: "workflow" | "agent"): Promise<void> {
    const limits = this.limits();
    const depth = this.options.run.childDepth + 1;
    if (depth > limits.maxDepth) {
      throw new ExecutionDepthExceededError(depth, limits.maxDepth);
    }
    const direct = await this.options.store.countDirectChildren(this.runId);
    if (direct >= limits.maxChildrenPerExecution) {
      throw new ExecutionLimitExceededError(
        "maxChildrenPerExecution",
        `Cannot create ${kind} child; maxChildrenPerExecution is ${limits.maxChildrenPerExecution}`,
      );
    }
    const tree = await this.options.store.countTreeExecutions(this.options.run.rootRunId || this.runId);
    if (tree >= limits.maxExecutionsPerTree) {
      throw new ExecutionLimitExceededError(
        "maxExecutionsPerTree",
        `Cannot create ${kind} child; maxExecutionsPerTree is ${limits.maxExecutionsPerTree}`,
      );
    }
  }

  private applyFailurePolicy(policy: string, executionId: string, error: Error): unknown {
    if (policy === "return-error") {
      return {
        ok: false,
        error: serializeError(error),
        executionId,
      };
    }
    if (error instanceof ChildExecutionTimeoutError || error instanceof ChildExecutionCancelledError || error instanceof ChildExecutionFailedError) {
      throw error;
    }
    throw new ChildExecutionFailedError(executionId, error.message, error);
  }

  private currentStepName: string | null = null;

  private async currentStep(name: string): Promise<StepRun | null> {
    const occurrence = this.occurrences.peek(name) - 1;
    if (occurrence < 0) {
      return null;
    }
    return this.options.store.getStepByIdentity(this.runId, name, occurrence);
  }

  private async dispatchDistributed<T>(args: {
    name: string;
    type: Extract<WorkItemType, "activity" | "agent" | "tool" | "mcp-tool" | "custom">;
    queue: string;
    input?: unknown;
    options?: StepOptions;
    payloadExtra?: Record<string, unknown>;
  }): Promise<T> {
    const occurrence = this.occurrences.next(args.name);
    await this.throwIfCancelled();
    const retry = normalizeRetry(args.options?.retry);
    const identity = operationIdentity(this.runId, args.name, occurrence);
    const idempotencyKey = args.options?.idempotencyKey ?? `task:${this.runId}:${args.name}:${occurrence}`;
    const existing = await this.options.store.getStepByIdentity(this.runId, args.name, occurrence);
    if (existing?.status === "COMPLETED") {
      return existing.output as T;
    }
    if (existing?.status === "FAILED") {
      throw restoreError(existing);
    }
    const existingTask = await this.options.store.getWorkItemByIdempotency(this.runId, idempotencyKey);
    if (existingTask?.status === "completed") {
      if (existing) {
        await this.options.store.updateStep(existing.id, {
          status: "COMPLETED",
          output: existingTask.result,
          completedAt: this.nowIso(),
        });
      }
      return existingTask.result as T;
    }
    if (existingTask?.status === "dead") {
      if (existing) {
        await this.options.store.updateStep(existing.id, {
          status: "FAILED",
          error: existingTask.error,
          completedAt: this.nowIso(),
        });
      }
      throw restoreError(existing ?? {
        error: existingTask.error,
        name: args.name,
      } as StepRun);
    }
    const input = assertSerializable(args.input ?? {}, `${args.type} ${args.name} input`);
    const payload = {
      stepName: args.name,
      input,
      idempotencyKey,
      retry,
      ...(args.payloadExtra ?? {}),
    };
    const bytes = payloadSizeBytes(payload);
    if (bytes > MAX_TASK_PAYLOAD_BYTES) {
      throw new TaskPayloadTooLargeError(bytes);
    }
    const stepType: StepType = args.type === "agent" ? "agent" : "activity";
    const step =
      existing ??
      (await this.options.store.insertStep({
        runId: this.runId,
        name: args.name,
        occurrence,
        type: stepType,
        input,
        status: "WAITING",
        attempt: 0,
        maxAttempts: retry.maxAttempts,
        timeoutMs: args.options?.timeout !== undefined ? parseDuration(args.options.timeout) : null,
        idempotencyKey,
      }));
    if (step.status !== "WAITING") {
      await this.options.store.updateStep(step.id, { status: "WAITING" });
    }
    if (!existing) {
      await this.options.store.appendHistory({
        runId: this.runId,
        type: "step.scheduled",
        payload: { name: args.name, stepId: step.id, type: stepType, operationId: identity, queue: args.queue },
      });
    }
    const task =
      existingTask ??
      (await this.options.store.enqueueWork({
        runId: this.runId,
        type: args.type,
        name: args.type === "agent" ? String(args.payloadExtra?.agentName ?? args.name) : args.name,
        queue: args.queue,
        payload: toJson({ ...payload, stepId: step.id }),
        maxAttempts: retry.maxAttempts,
        idempotencyKey,
        priority: 0,
      }));
    this.options.notifier.ping();
    throw new WorkflowSuspend({ type: "task", ref: task.id });
  }

  private async executeDurable<T>(
    name: string,
    type: StepType,
    options: StepOptions,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const occurrence = this.occurrences.next(name);
    await this.throwIfCancelled();
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

    if (existing?.status === "RUNNING") {
      this.currentStepName = name;
      try {
        const output = await withTimeout(fn, timeoutMs, this.abortSignal);
        const json = toJson(output);
        await this.options.store.updateStep(existing.id, {
          status: "COMPLETED",
          output: json,
          completedAt: this.nowIso(),
        });
        await this.options.store.appendHistory({
          runId: this.runId,
          type: "step.completed",
          payload: { name, stepId: existing.id, attempt: existing.attempt },
        });
        return output;
      } catch (error) {
        if (error instanceof WorkflowSuspend) {
          throw error;
        }
        const persisted = serializeError(error, { attempt: existing.attempt, operationId: identity });
        const retryable = shouldRetry(retry, existing.attempt) && !(error instanceof CancellationError) && !isPermanentInteropError(error);
        await this.options.store.updateStep(existing.id, {
          status: retryable ? "RETRYING" : "FAILED",
          error: persisted,
          completedAt: retryable ? null : this.nowIso(),
        });
        if (!retryable) {
          throw error;
        }
        const delay = computeBackoffMs(retry, existing.attempt);
        await this.options.store.enqueueWork({
          runId: this.runId,
          type: "execute_run",
          availableAt: new Date(this.options.clock.now().getTime() + delay),
        });
        this.options.notifier.ping();
        throw new WorkflowSuspend({ type: "retry", ref: existing.id });
      } finally {
        this.currentStepName = null;
      }
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
      const retryable =
        shouldRetry(retry, attempt) &&
        !(error instanceof CancellationError) &&
        !isPermanentInteropError(error);
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

  private recordClock(kind: "now" | "random" | "uuid", produce: () => unknown): unknown {
    const occurrence = this.clocks.next(kind);
    const key = `${kind}:${occurrence}`;
    if (this.clockValues.has(key)) {
      return this.clockValues.get(key);
    }
    const value = produce();
    this.clockValues.set(key, value);
    this.pendingWrites.push(
      this.options.store.insertDeterministicValue({ runId: this.runId, kind, occurrence, value }).then(() =>
        this.options.store.appendHistory({
          runId: this.runId,
          type: kind === "now" ? "clock.now" : kind === "random" ? "clock.random" : "clock.uuid",
          payload: { occurrence, value: value as never },
        }),
      ).then(() => undefined),
    );
    return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInlineAgentOptions(value: unknown): value is AgentTaskOptions {
  return isRecord(value) && typeof value.model === "string";
}

function isWrappedAgentOptions(
  value: unknown,
): value is {
  agent: AgentDefinition;
  input?: unknown;
  prompt?: string;
  retry?: StepOptions["retry"];
  timeout?: StepOptions["timeout"];
} & ChildExecutionOptions {
  return isRecord(value) && isRecord(value.agent) && typeof value.agent.name === "string";
}

function extractChildOptions(value: unknown): ChildExecutionOptions {
  if (!isRecord(value)) {
    return {};
  }
  const options: ChildExecutionOptions = {};
  if (typeof value.name === "string") {
    options.name = value.name;
  }
  if (value.retry) {
    options.retry = value.retry as ChildExecutionOptions["retry"];
  }
  if (typeof value.timeout === "string" || typeof value.timeout === "number") {
    options.timeout = value.timeout;
  }
  if (value.cancellation === "propagate" || value.cancellation === "detach") {
    options.cancellation = value.cancellation;
  }
  if (value.onFailure === "fail-parent" || value.onFailure === "return-error") {
    options.onFailure = value.onFailure;
  }
  if (typeof value.queue === "string") {
    options.queue = value.queue;
  }
  return options;
}

function childErrorFor(child: WorkflowRun): Error {
  if (child.status === "CANCELLED") {
    return new ChildExecutionCancelledError(child.id, child.error?.message);
  }
  if (child.error?.name === "ChildExecutionTimeoutError" || child.error?.name === "TimeoutError") {
    return new ChildExecutionTimeoutError(child.id, child.error.message);
  }
  return new ChildExecutionFailedError(
    child.id,
    child.error?.message ?? `Child workflow ${child.id} ${child.status.toLowerCase()}`,
  );
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

function toCapability(
  target: ToolDefinition | { kind?: string; name: string } | Capability,
  mcp?: McpManager,
  authProvider?: AuthProvider,
): Capability {
  if (target && typeof target === "object" && typeof (target as Capability).invoke === "function") {
    return target as Capability;
  }
  if (isMcpToolRef(target)) {
    if (!mcp) {
      throw new Error(`MCP manager is required to invoke ${target.name}`);
    }
    return mcpToolCapability(target, mcp, authProvider);
  }
  if (isRecord(target) && typeof target.name === "string" && typeof (target as ToolDefinition).execute === "function") {
    return localToolCapability(target as ToolDefinition);
  }
  throw new Error("ctx.tool() requires a tool definition, MCP tool, or capability");
}
