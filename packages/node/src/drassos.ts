import {
  createDrassos,
  type Drassos as Engine,
  type DrassosConfig,
} from "@drassos/engine";
import type {
  HumanDecision,
  HumanInteraction,
  ToolDefinition,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStatus,
} from "@drassos/core";

export type NodeConfig = DrassosConfig & {
  database?: string;
};

export interface ExecutionResult<T = unknown> {
  runId: string;
  status: WorkflowStatus;
  output: T | null;
  error: WorkflowRun["error"];
  run: WorkflowRun;
}

const TERMINAL: WorkflowStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

export class Drassos {
  private readonly config: DrassosConfig;
  private readonly pendingWorkflows: WorkflowDefinition[] = [];
  private readonly pendingTools: ToolDefinition[] = [];
  private engine: Engine | undefined;

  constructor(config: NodeConfig = {}) {
    const { database, ...rest } = config;
    this.config = {
      ...rest,
      databaseUrl: rest.databaseUrl ?? database,
    };
  }

  register(workflow: WorkflowDefinition): this {
    const alreadyQueued = this.pendingWorkflows.some(
      (item) => item.name === workflow.name && item.version === workflow.version,
    );
    if (!alreadyQueued) {
      this.pendingWorkflows.push(workflow);
    }
    if (this.engine && !this.engine.registry.has(workflow.name, workflow.version)) {
      this.engine.registry.register(workflow);
    }
    return this;
  }

  tool(definition: ToolDefinition): this {
    this.pendingTools.push(definition);
    if (this.engine) {
      this.engine.tool(definition.name, definition);
    }
    return this;
  }

  async start(): Promise<this> {
    if (!this.engine) {
      this.engine = await createDrassos({
        ...this.config,
        workflows: [...(this.config.workflows ?? []), ...this.pendingWorkflows],
        tools: [...(this.config.tools ?? []), ...this.pendingTools],
      });
    }
    await this.engine.startWorker();
    return this;
  }

  async execute<TInput = unknown, TOutput = unknown>(
    workflow: WorkflowDefinition<TInput, TOutput> | string,
    input?: TInput,
    options?: { version?: string; timeoutMs?: number },
  ): Promise<ExecutionResult<TOutput>> {
    if (typeof workflow !== "string") {
      this.register(workflow as WorkflowDefinition);
    }
    await this.start();
    const name = typeof workflow === "string" ? workflow : workflow.name;
    const run = await this.requireEngine().executor.startRun(name, input ?? {}, undefined, {
      version: options?.version,
    });
    return this.wait(run.id, options?.timeoutMs) as Promise<ExecutionResult<TOutput>>;
  }

  async wait(runId: string, timeoutMs = 30_000): Promise<ExecutionResult> {
    const engine = this.requireEngine();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const run = await engine.store.getRun(runId);
      if (run && TERMINAL.includes(run.status)) {
        return {
          runId,
          status: run.status,
          output: run.output as never,
          error: run.error,
          run,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for run ${runId}`);
  }

  async signal(runId: string, name: string, payload?: unknown): Promise<{ signalId: string; duplicate: boolean }> {
    return this.requireEngine().signal(runId, name, payload);
  }

  async completeInteraction(
    runId: string,
    interactionId: string,
    decision: HumanDecision | Record<string, unknown>,
  ): Promise<HumanInteraction> {
    return this.requireEngine().completeInteraction(runId, interactionId, decision);
  }

  async getPendingInteractions(runId?: string): Promise<HumanInteraction[]> {
    return this.requireEngine().getPendingInteractions(runId);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.requireEngine().store.getRun(runId);
  }

  async history(runId: string) {
    return this.requireEngine().store.listHistory(runId);
  }

  runtime(): Engine {
    return this.requireEngine();
  }

  async stop(): Promise<void> {
    if (this.engine) {
      await this.engine.stop();
      this.engine = undefined;
    }
  }

  private requireEngine(): Engine {
    if (!this.engine) {
      throw new Error("Drassos has not been started. Call start() first.");
    }
    return this.engine;
  }
}
