import { HumanTaskNotFoundError, RunNotFoundError, WorkflowSuspend, serializeError } from "../core/errors.ts";
import { toJson } from "../core/serialize.ts";
import { isTerminalStatus, transitionRun } from "../core/status.ts";
import type { Clock, Json, WorkflowRun } from "../core/types.ts";
import type { Store } from "../persistence/store.ts";
import type { AgentProvider } from "../sdk/types.ts";
import { DurableContext } from "./context.ts";
import type { Logger } from "./logger.ts";
import type { McpManager } from "./mcp.ts";
import type { WorkNotifier } from "./notifier.ts";
import type { WorkflowRegistry } from "./registry.ts";

export class Executor {
  constructor(
    private readonly options: {
      store: Store;
      registry: WorkflowRegistry;
      clock: Clock;
      logger: Logger;
      notifier: WorkNotifier;
      defaultAgentProvider?: AgentProvider;
      mcp?: McpManager;
      maxChildDepth?: number;
      workerId?: string;
      leaseMs?: number;
    },
  ) {}

  async startRun(workflowName: string, input: unknown, id?: string): Promise<WorkflowRun> {
    const definition = this.options.registry.get(workflowName);
    await this.options.store.registerWorkflow(definition.name, definition.version);
    const run = await this.options.store.createRun({
      id,
      workflowName: definition.name,
      workflowVersion: definition.version,
      input,
    });
    await this.options.store.enqueueWork({
      runId: run.id,
      type: "execute_run",
    });
    this.options.notifier.ping();
    this.options.logger.info({ runId: run.id, workflowName }, "workflow run created");
    return run;
  }

  async executeRun(runId: string): Promise<void> {
    const latest = await this.options.store.getRun(runId);
    if (!latest || isTerminalStatus(latest.status)) {
      return;
    }
    const definition = this.options.registry.get(latest.workflowName, latest.workflowVersion);
    const abort = new AbortController();
    const now = this.options.clock.now().toISOString();

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
      maxChildDepth: this.options.maxChildDepth,
    });

    try {
      const output = await definition.fn(ctx);
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
    if (run.waitType === "human" && run.waitRef) {
      const task = await this.options.store.getHumanTask(run.waitRef);
      if (task?.status === "completed") {
        await this.options.store.enqueueWork({ runId, type: "execute_run" });
        this.options.notifier.ping();
      }
    }
    if (run.waitType === "timer" && run.waitRef) {
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
    if (parent?.status === "WAITING" && parent.waitType === "child" && parent.waitRef === runId) {
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
    if (run.status === "WAITING" && run.waitType === "event" && run.waitRef === type) {
      await this.options.store.enqueueWork({ runId, type: "execute_run" });
      this.options.notifier.ping();
    }
    return { eventId: event.id, duplicate };
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
    await this.options.store.cancelOpenAgentRuns(runId);
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

  async inspectRun(runId: string) {
    const run = await this.options.store.getRun(runId);
    if (!run) {
      return null;
    }
    const [steps, history, tasks, timers, events, tools, agents, agentRuns, children, toolCalls, modelCalls] =
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
    return {
      run,
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
