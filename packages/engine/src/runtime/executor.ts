import {
  ChildExecutionTimeoutError,
  CompatibleWorkerMissing,
  HumanTaskNotFoundError,
  InteractionAlreadyCompletedError,
  InteractionNotFoundError,
  InvalidSignalError,
  RunNotFoundError,
  SignalNotAllowedError,
  WorkflowSuspend,
  serializeError,
} from "../core/errors.ts";
import { toJson } from "../core/serialize.ts";
import { isTerminalStatus, transitionRun } from "../core/status.ts";
import type {
  Clock,
  ExecutionMetadata,
  ExecutionNode,
  HumanDecision,
  HumanInteraction,
  Json,
  ObservabilityConfig,
  OrchestrationLimits,
  WorkflowRun,
} from "../core/types.ts";
import type { Store } from "../persistence/store.ts";
import { assertSignalName, decisionsMatch, humanSignalName, parseHumanDecision } from "../sdk/signals.ts";
import type { AgentProvider } from "../sdk/types.ts";
import { DurableContext } from "./context.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { buildExecutionTree, loadExecution } from "./executions.ts";
import type { Logger } from "./logger.ts";
import type { McpManager } from "./mcp.ts";
import type { WorkNotifier } from "./notifier.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { ModelRegistry } from "../models/model-registry.ts";
import type { ToolRegistry } from "../tools/tool-registry.ts";
import type { AuthProvider } from "../capabilities/auth.ts";

export class Executor {
  private readonly inflightAborts = new Map<string, AbortController>();

  constructor(
    private readonly options: {
      store: Store;
      registry: WorkflowRegistry;
      clock: Clock;
      logger: Logger;
      notifier: WorkNotifier;
      defaultAgentProvider?: AgentProvider;
      mcp?: McpManager;
      models?: ModelRegistry;
      toolRegistry?: ToolRegistry;
      agentRegistry?: AgentRegistry;
      authProvider?: AuthProvider;
      maxChildDepth?: number;
      orchestrationLimits?: OrchestrationLimits;
      workerId?: string;
      leaseMs?: number;
      observability?: ObservabilityConfig;
    },
  ) {}

  async startRun(
    workflowName: string,
    input: unknown,
    id?: string,
    options?: { enqueue?: boolean; version?: string },
  ): Promise<WorkflowRun> {
    const definition = this.options.registry.get(workflowName, options?.version);
    await this.options.store.registerWorkflow(definition.name, definition.version);
    const run = await this.options.store.createRun({
      id,
      workflowName: definition.name,
      workflowVersion: definition.version,
      input,
    });
    if (options?.enqueue !== false) {
      await this.options.store.enqueueWork({
        runId: run.id,
        type: "execute_run",
      });
      this.options.notifier.ping();
    }
    this.options.logger.info({ runId: run.id, workflowName }, "workflow run created");
    return run;
  }

  async executeRun(runId: string): Promise<void> {
    const latest = await this.options.store.getRun(runId);
    if (!latest || isTerminalStatus(latest.status)) {
      return;
    }
    if (!this.options.registry.has(latest.workflowName, latest.workflowVersion)) {
      await this.options.store.updateRun(runId, {
        waitType: "compatible-worker",
        waitRef: `${latest.workflowName}@${latest.workflowVersion}`,
      });
      this.options.logger.info(
        {
          executionId: runId,
          runId,
          workflowName: latest.workflowName,
          workflowVersion: latest.workflowVersion,
          workerId: this.options.workerId ?? null,
        },
        "waiting for compatible worker",
      );
      throw new CompatibleWorkerMissing(latest.workflowName, latest.workflowVersion);
    }
    const definition = this.options.registry.get(latest.workflowName, latest.workflowVersion);
    const abort = new AbortController();
    const now = this.options.clock.now().toISOString();
    const deterministicValues = await this.options.store.listDeterministicValues(runId);

    if (latest.status === "PENDING") {
      transitionRun(latest.status, "start");
      await this.options.store.updateRun(runId, { status: "RUNNING", startedAt: now });
      await this.options.store.appendHistory({
        runId,
        type: "workflow.started",
        payload: { workflowName: latest.workflowName },
      });
    } else if (latest.status === "WAITING") {
      transitionRun(latest.status, "resume");
      await this.options.store.updateRun(runId, {
        status: "RUNNING",
        waitType: null,
        waitRef: null,
      });
      await this.options.store.appendHistory({
        runId,
        type: "workflow.resumed",
        payload: {},
      });
    } else if (latest.status === "RUNNING") {
      await this.options.store.appendHistory({
        runId,
        type: "workflow.resumed",
        payload: { recovered: true },
      });
    }

    const run = (await this.options.store.getRun(runId)) ?? latest;
    this.inflightAborts.set(runId, abort);
    const ctx = new DurableContext({
      store: this.options.store,
      run,
      clock: this.options.clock,
      logger: this.options.logger.child({ runId }),
      abortSignal: abort.signal,
      notifier: this.options.notifier,
      defaultAgentProvider: this.options.defaultAgentProvider,
      mcp: this.options.mcp,
      registry: this.options.registry,
      models: this.options.models,
      toolRegistry: this.options.toolRegistry,
      agentRegistry: this.options.agentRegistry,
      authProvider: this.options.authProvider,
      maxChildDepth: this.options.maxChildDepth,
      orchestrationLimits: this.options.orchestrationLimits,
      cancelExecution: (executionId, reason) => this.cancelExecution(executionId, reason),
      getExecutionStatus: async (executionId) => {
        const execution = await this.getExecution(executionId);
        if (!execution) {
          throw new RunNotFoundError(executionId);
        }
        return execution.status;
      },
      deterministicValues,
    });

    try {
      const output = await definition.fn(ctx);
      await ctx.flushDeterministic();
      const current = await this.options.store.getRun(runId);
      if (current?.status === "CANCELLED") {
        return;
      }
      transitionRun("RUNNING", "complete");
      await this.options.store.updateRun(runId, {
        status: "COMPLETED",
        output: toJson(output),
        completedAt: this.options.clock.now().toISOString(),
        waitType: null,
        waitRef: null,
      });
      await this.options.store.appendHistory({
        runId,
        type: "workflow.completed",
        payload: {},
      });
      this.options.logger.info({ runId }, "workflow completed");
      await this.notifyParent(runId);
    } catch (error) {
      await ctx.flushDeterministic().catch(() => undefined);
      if (error instanceof WorkflowSuspend) {
        const current = await this.options.store.getRun(runId);
        if (current?.status === "CANCELLED") {
          return;
        }
        const primary = error.waits[0] ?? { type: "join" as const, ref: "wait" };
        transitionRun("RUNNING", "wait");
        await this.options.store.updateRun(runId, {
          status: "WAITING",
          waitType: primary.type,
          waitRef: primary.ref,
        });
        await this.options.store.appendHistory({
          runId,
          type: "workflow.waiting",
          payload: { waits: error.waits },
        });
        this.options.logger.info({ runId, waits: error.waits }, "workflow waiting");
        await this.maybeWakeImmediately(runId);
        return;
      }
      const current = await this.options.store.getRun(runId);
      if (current?.status === "CANCELLED") {
        return;
      }
      const persisted = serializeError(error);
      await this.options.store.updateRun(runId, {
        status: "FAILED",
        error: persisted,
        completedAt: this.options.clock.now().toISOString(),
      });
      await this.options.store.appendHistory({
        runId,
        type: "workflow.failed",
        payload: { error: persisted },
      });
      this.options.logger.error({ runId, err: persisted }, "workflow failed");
      await this.notifyParent(runId);
    } finally {
      this.inflightAborts.delete(runId);
      abort.abort();
    }
  }

  async maybeWakeImmediately(runId: string): Promise<void> {
    const run = await this.options.store.getRun(runId);
    if (!run || run.status !== "WAITING") {
      return;
    }
    if (run.waitType === "event" && run.waitRef) {
      const event = await this.options.store.findUnconsumedEvent(runId, run.waitRef);
      if (event) {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
    }
    if (run.waitType === "signal" && run.waitRef) {
      const event = await this.options.store.findUnconsumedEvent(runId, run.waitRef);
      if (event) {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
    }
    if (run.waitType === "human" && run.waitRef) {
      const task = await this.options.store.getHumanTask(run.waitRef);
      if (task?.status === "completed") {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
      const interaction = await this.options.store.getInteraction(runId, run.waitRef);
      if (interaction && interaction.status !== "pending") {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
    }
    if (
      (run.waitType === "timer" || run.waitType === "signal" || run.waitType === "human") &&
      run.waitRef
    ) {
      const due = await this.options.store.listDueTimers(50);
      if (due.some((timer) => timer.id === run.waitRef || timer.runId === runId)) {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
    }
    if (run.waitType === "child" && run.waitRef) {
      const child = await this.options.store.getRun(run.waitRef);
      if (child && isTerminalStatus(child.status)) {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
    }
    if (run.waitType === "task" && run.waitRef) {
      const task = await this.options.store.getWorkItem(run.waitRef);
      if (task && (task.status === "completed" || task.status === "dead")) {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
    }
  }

  async recoverWaitingParents(): Promise<number> {
    const parents = await this.options.store.listWaitingParentsWithTerminalChildren();
    for (const parent of parents) {
      await this.options.store.enqueueWork({ runId: parent.id, type: "execute_run" });
      this.options.notifier.ping();
    }
    return parents.length;
  }

  async notifyParent(runId: string): Promise<void> {
    const child = await this.options.store.getRun(runId);
    if (!child?.parentRunId) {
      return;
    }
    const parent = await this.options.store.getRun(child.parentRunId);
    if (parent?.status === "WAITING") {
      await this.options.store.enqueueWork({ runId: parent.id, type: "execute_run" });
      this.options.notifier.ping();
    }
  }

  async deliverEvent(runId: string, type: string, data: unknown, deliveryId?: string): Promise<{
    eventId: string;
    duplicate: boolean;
  }> {
    const run = await this.options.store.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    const before = deliveryId
      ? (await this.options.store.listEvents(runId)).find((event) => event.deliveryId === deliveryId)
      : undefined;
    const event = await this.options.store.appendEvent({
      runId,
      type,
      data,
      deliveryId: deliveryId ?? null,
    });
    const duplicate = Boolean(before && before.id === event.id);
    if (!duplicate) {
      await this.options.store.appendHistory({
        runId,
        type: "event.received",
        payload: { type, eventId: event.id, deliveryId: event.deliveryId },
      });
    }
    if (
      (run.status === "WAITING" && run.waitType === "event" && run.waitRef === type) ||
      (run.status === "WAITING" && run.waitType === "signal" && run.waitRef === type) ||
      (run.status === "WAITING" && run.waitType === "human" && humanSignalName(run.waitRef ?? "") === type)
    ) {
      await this.options.store.enqueueWork({ runId, type: "execute_run" });
      this.options.notifier.ping();
    }
    return { eventId: event.id, duplicate };
  }

  async signal(
    runId: string,
    name: string,
    payload: unknown,
    options?: { id?: string },
  ): Promise<{ signalId: string; duplicate: boolean }> {
    const signalName = assertSignalName(name);
    const run = await this.options.store.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    if (isTerminalStatus(run.status)) {
      throw new SignalNotAllowedError(runId, run.status);
    }
    const before = options?.id
      ? (await this.options.store.listEvents(runId)).find((event) => event.deliveryId === options.id)
      : undefined;
    const event = await this.options.store.appendEvent({
      runId,
      type: signalName,
      data: payload,
      deliveryId: options?.id ?? null,
    });
    const duplicate = Boolean(before && before.id === event.id);
    if (!duplicate) {
      await this.options.store.appendHistory({
        runId,
        type: "signal.received",
        payload: {
          signalId: event.id,
          name: signalName,
          payload: toJson(payload),
          id: event.deliveryId,
        },
      });
    }
    if (
      run.status === "WAITING" &&
      ((run.waitType === "signal" && run.waitRef === signalName) ||
        (run.waitType === "event" && run.waitRef === signalName) ||
        (run.waitType === "human" && humanSignalName(run.waitRef ?? "") === signalName))
    ) {
      await this.options.store.enqueueWork({ runId, type: "execute_run" });
      this.options.notifier.ping();
    }
    return { signalId: event.id, duplicate };
  }

  async completeInteraction(
    runId: string,
    interactionId: string,
    decisionInput: unknown,
  ): Promise<HumanInteraction> {
    const decision = parseHumanDecision(decisionInput);
    if (decision.outcome === "timed_out") {
      throw new InvalidSignalError("timed_out is reserved for durable timeouts");
    }
    const pending = await this.options.store.getPendingInteraction(runId, interactionId);
    if (!pending) {
      const existing = await this.options.store.getInteraction(runId, interactionId);
      if (!existing) {
        throw new InteractionNotFoundError(runId, interactionId);
      }
      if (existing.decision && decisionsMatch(existing.decision, decision)) {
        return existing;
      }
      throw new InteractionAlreadyCompletedError(interactionId);
    }
    const status =
      decision.outcome === "approved"
        ? "approved"
        : decision.outcome === "rejected"
          ? "rejected"
          : "changes_requested";
    const completed = await this.options.store.completeInteraction(pending.id, status, decision);
    if (!completed) {
      const existing = await this.options.store.getInteraction(runId, interactionId);
      if (existing?.decision && decisionsMatch(existing.decision, decision)) {
        return existing;
      }
      throw new InteractionAlreadyCompletedError(interactionId);
    }
    await this.options.store.appendHistory({
      runId,
      type: "human.interaction.completed",
      payload: { interactionId, recordId: completed.id, decision: toJson(decision) },
    });
    await this.signal(runId, humanSignalName(interactionId), decision, {
      id: `interaction:${completed.id}`,
    });
    return completed;
  }

  async getPendingInteractions(runId?: string): Promise<HumanInteraction[]> {
    return this.options.store.listInteractions({
      runId,
      status: "pending",
    });
  }

  async getInteraction(runId: string, interactionId: string): Promise<HumanInteraction | null> {
    return this.options.store.getInteraction(runId, interactionId);
  }

  async completeHumanTask(taskId: string, response: unknown) {
    const task = await this.options.store.getHumanTask(taskId);
    if (!task) {
      throw new HumanTaskNotFoundError(taskId);
    }
    const completed = await this.options.store.completeHumanTask(taskId, response);
    if (!completed) {
      return task;
    }
    await this.options.store.appendHistory({
      runId: task.runId,
      type: "human.completed",
      payload: { name: task.name, taskId: task.id },
    });
    const run = await this.options.store.getRun(task.runId);
    if (run && run.status === "WAITING") {
      await this.options.store.enqueueWork({ runId: task.runId, type: "execute_run" });
      this.options.notifier.ping();
    }
    return completed;
  }

  async cancelRun(runId: string, reason?: string): Promise<WorkflowRun> {
    const run = await this.options.store.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    if (run.status === "COMPLETED" || run.status === "FAILED") {
      return run;
    }
    if (run.status === "CANCELLED") {
      return run;
    }
    const cancelledAt = this.options.clock.now().toISOString();
    const updated = await this.options.store.updateRun(runId, {
      status: "CANCELLED",
      cancellation: { reason, cancelledAt },
      completedAt: cancelledAt,
      waitType: null,
      waitRef: null,
    });
    await this.options.store.cancelPendingTimers(runId);
    await this.options.store.cancelPendingHumanTasks(runId);
    const cancelledInteractions = await this.options.store.cancelPendingInteractions(runId);
    for (const interaction of cancelledInteractions) {
      await this.options.store.appendHistory({
        runId,
        type: "human.interaction.cancelled",
        payload: { interactionId: interaction.interactionId, recordId: interaction.id },
      });
    }
    const cancelledAgents = await this.options.store.cancelOpenAgentRuns(runId);
    for (const agentRunId of cancelledAgents) {
      await this.options.store.appendHistory({
        runId,
        type: "agent.run.cancelled",
        payload: { agentRunId, reason: reason ?? null },
      });
    }
    this.inflightAborts.get(runId)?.abort();
    await this.cancelRemoteOperations(runId, reason);
    await this.options.store.appendHistory({
      runId,
      type: "workflow.cancelled",
      payload: { reason: reason ?? null },
    });
    this.options.logger.info({ runId, reason }, "workflow cancelled");
    const children = await this.options.store.listChildren(runId);
    for (const child of children) {
      if (child.cancelOnParentCancel && !isTerminalStatus(child.status)) {
        await this.cancelRun(child.id, reason ?? "parent cancelled");
      }
    }
    await this.notifyParent(runId);
    return updated;
  }

  async failTimedOutChildren(): Promise<number> {
    const due = await this.options.store.listTimedOutRuns(this.options.clock.now().toISOString());
    let failed = 0;
    for (const run of due) {
      if (isTerminalStatus(run.status)) {
        continue;
      }
      const error = new ChildExecutionTimeoutError(run.id);
      const persisted = serializeError(error);
      await this.options.store.updateRun(run.id, {
        status: "FAILED",
        error: persisted,
        completedAt: this.options.clock.now().toISOString(),
        waitType: null,
        waitRef: null,
      });
      await this.options.store.appendHistory({
        runId: run.id,
        type: "execution.failed",
        payload: { error: persisted, reason: "timeout" },
      });
      this.inflightAborts.get(run.id)?.abort();
      if (run.cancellationPolicy !== "detach") {
        const children = await this.options.store.listChildren(run.id);
        for (const child of children) {
          if (child.cancelOnParentCancel && !isTerminalStatus(child.status)) {
            await this.cancelRun(child.id, "parent timed out");
          }
        }
      }
      await this.notifyParent(run.id);
      failed += 1;
    }
    return failed;
  }

  async getExecution(executionId: string): Promise<ExecutionMetadata | null> {
    return loadExecution(this.options.store, executionId);
  }

  async getExecutionTree(executionId: string): Promise<ExecutionNode> {
    return buildExecutionTree(this.options.store, executionId);
  }

  async cancelExecution(executionId: string, reason?: string): Promise<unknown> {
    const workflow = await this.options.store.getRun(executionId);
    if (workflow) {
      return this.cancelRun(executionId, reason);
    }
    const agent = await this.options.store.getAgentRun(executionId);
    if (!agent) {
      throw new RunNotFoundError(executionId);
    }
    if (agent.status === "COMPLETED" || agent.status === "FAILED" || agent.status === "CANCELLED" || agent.status === "TIMED_OUT") {
      return agent;
    }
    const updated = await this.options.store.updateAgentRun(executionId, {
      status: "CANCELLED",
      completedAt: this.options.clock.now().toISOString(),
    });
    await this.options.store.appendHistory({
      runId: agent.runId,
      type: "execution.cancelled",
      payload: { executionId, reason: reason ?? null },
    });
    const descendants = await this.options.store.listDescendantAgentRuns(executionId);
    for (const child of descendants) {
      if (child.cancellationPolicy === "detach") {
        continue;
      }
      if (child.status === "COMPLETED" || child.status === "FAILED" || child.status === "CANCELLED" || child.status === "TIMED_OUT") {
        continue;
      }
      await this.options.store.updateAgentRun(child.id, {
        status: "CANCELLED",
        completedAt: this.options.clock.now().toISOString(),
      });
    }
    return updated;
  }

  async inspectRun(runId: string) {
    const run = await this.options.store.getRun(runId);
    if (!run) {
      return null;
    }
    const [steps, history, tasks, timers, events, tools, agents, agentRuns, children, toolCalls, modelCalls, interactions, remoteOperations, replays] =
      await Promise.all([
        this.options.store.listSteps(runId),
        this.options.store.listHistory(runId),
        this.options.store.listHumanTasks({ runId }),
        this.options.store.listTimers(runId),
        this.options.store.listEvents(runId),
        this.options.store.listToolInvocations(runId),
        this.options.store.listAgentExecutions(runId),
        this.options.store.listAgentRuns(runId),
        this.options.store.listChildren(runId),
        this.options.store.listToolCalls({ runId }),
        this.options.store.listModelCallsForRun(runId),
        this.options.store.listInteractions({ runId }),
        this.options.store.listRemoteOperations(runId),
        this.options.store.listReplayRecords(runId),
      ]);
    const agentRunDetails = await Promise.all(
      agentRuns.map(async (agentRun) => ({
        ...agentRun,
        turns: await this.options.store.listAgentTurns(agentRun.id),
        modelCalls: modelCalls.filter((call) => call.agentRunId === agentRun.id),
        toolCalls: toolCalls.filter((call) => call.agentRunId === agentRun.id),
      })),
    );
    const parent = run.parentRunId ? await this.options.store.getRun(run.parentRunId) : null;
    const tree = await this.getExecutionTree(runId).catch(() => null);
    const pendingInteraction = interactions.find((item) => item.status === "pending");
    const waitingFor =
      run.status === "WAITING" && run.waitType
        ? run.waitType === "human" && pendingInteraction
          ? {
              type: "human",
              name: pendingInteraction.interactionId,
              title: pendingInteraction.title,
              createdAt: pendingInteraction.createdAt,
            }
          : { type: run.waitType, name: run.waitRef }
        : null;
    return {
      run,
      waitingFor,
      steps,
      history,
      tasks,
      timers,
      events,
      tools,
      agents,
      agentRuns: agentRunDetails,
      toolCalls,
      modelCalls,
      children,
      parent,
      tree,
      interactions,
      remoteOperations,
      replays,
    };
  }

  async inspectAgentRun(agentRunId: string) {
    const agentRun = await this.options.store.getAgentRun(agentRunId);
    if (!agentRun) {
      return null;
    }
    const [turns, modelCalls, toolCalls] = await Promise.all([
      this.options.store.listAgentTurns(agentRunId),
      this.options.store.listModelCalls(agentRunId),
      this.options.store.listToolCalls({ agentRunId }),
    ]);
    return { agentRun, turns, modelCalls, toolCalls };
  }

  async forkRun(runId: string, seq: number): Promise<WorkflowRun> {
    const source = await this.options.store.getRun(runId);
    if (!source) {
      throw new RunNotFoundError(runId);
    }
    const history = await this.options.store.listHistory(runId);
    const at = history.find((event) => event.seq === seq) ?? history[history.length - 1];
    if (!at) {
      throw new RunNotFoundError(runId);
    }
    const fork = await this.options.store.createRun({
      workflowName: source.workflowName,
      workflowVersion: source.workflowVersion,
      input: source.input,
      forkedFromRunId: source.id,
      forkedFromSeq: seq,
    });
    const cutoff = new Date(at.timestamp).getTime();
    const steps = await this.options.store.listSteps(runId);
    for (const step of steps) {
      if (step.status !== "COMPLETED" || !step.completedAt || new Date(step.completedAt).getTime() > cutoff) {
        continue;
      }
      const copied = await this.options.store.insertStep({
        runId: fork.id,
        name: step.name,
        occurrence: step.occurrence,
        type: step.type,
        input: step.input,
        status: "COMPLETED",
        attempt: step.attempt,
        maxAttempts: step.maxAttempts,
        timeoutMs: step.timeoutMs,
        idempotencyKey: step.idempotencyKey,
        startedAt: step.startedAt,
      });
      await this.options.store.updateStep(copied.id, {
        output: step.output,
        completedAt: step.completedAt,
        error: step.error,
      });
    }
    await this.options.store.appendHistory({
      runId: fork.id,
      type: "workflow.started",
      payload: { forkedFromRunId: source.id, forkedFromSeq: seq },
    });
    await this.options.store.enqueueWork({ runId: fork.id, type: "execute_run" });
    this.options.notifier.ping();
    return fork;
  }

  private async cancelRemoteOperations(runId: string, reason?: string): Promise<void> {
    const operations = await this.options.store.listRemoteOperations(runId);
    for (const operation of operations) {
      if (!["PENDING", "SENDING", "WORKING"].includes(operation.status) || !operation.remoteTaskId) {
        continue;
      }
      if (operation.endpointRef.startsWith("http://") || operation.endpointRef.startsWith("https://")) {
        try {
          await fetch(operation.endpointRef, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tasks/cancel",
              params: { id: operation.remoteTaskId },
            }),
          });
        } catch (error) {
          await this.options.store.appendHistory({
            runId,
            type: "capability.cancelled",
            payload: {
              capabilityId: operation.capabilityId,
              remoteTaskId: operation.remoteTaskId,
              cancelFailed: true,
              reason: reason ?? null,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          continue;
        }
      }
      await this.options.store.updateRemoteOperation(operation.id, {
        status: "CANCELLED",
        completedAt: this.options.clock.now().toISOString(),
      });
      await this.options.store.appendHistory({
        runId,
        type: "capability.cancelled",
        payload: {
          capabilityId: operation.capabilityId,
          remoteTaskId: operation.remoteTaskId,
          reason: reason ?? null,
        },
      });
    }
  }
}

export async function fireDueTimers(store: Store, notifier: WorkNotifier): Promise<number> {
  const due = await store.listDueTimers(25);
  let fired = 0;
  for (const timer of due) {
    const result = await store.fireTimer(timer.id);
    if (!result) {
      continue;
    }
    fired += 1;
    await store.appendHistory({
      runId: timer.runId,
      type: "timer.fired",
      payload: { timerId: timer.id },
    });
    await store.enqueueWork({ runId: timer.runId, type: "execute_run" });
    notifier.ping();
  }
  return fired;
}

export type { Json };
