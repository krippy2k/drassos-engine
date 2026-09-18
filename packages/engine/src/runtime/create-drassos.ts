import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "../core/types.ts";
import { createDbClient, type DbClient } from "../persistence/client.ts";
import { migrate } from "../persistence/migrate.ts";
import { Store } from "../persistence/store.ts";
import { OpenAIAgentProvider } from "../agents/providers.ts";
import type { AgentProvider, DrassosApp, ToolDefinition, WorkflowDefinition } from "../sdk/types.ts";
import type { ExecutionMetadata, ExecutionNode, HumanDecision, HumanInteraction, ObservabilityConfig, OrchestrationLimits } from "../core/types.ts";
import { RunNotFoundError } from "../core/errors.ts";
import { Executor } from "./executor.ts";
import { createLogger, type Logger } from "./logger.ts";
import { WorkNotifier } from "./notifier.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { WorkflowRegistry } from "./registry.ts";
import { Worker } from "./worker.ts";
import { WorkerControlPlane } from "../worker/control-plane.ts";
import { Observability } from "../observability/index.ts";
import { McpManager } from "./mcp.ts";
import { ModelRegistry } from "../models/model-registry.ts";
import type { ModelProvider } from "../models/model-types.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { CapabilityRegistry } from "../capabilities/registry.ts";
import { envAuthProvider, type AuthProvider } from "../capabilities/auth.ts";
import { localAgentCapability, localToolCapability, localWorkflowCapability } from "../capabilities/local.ts";
import { exportExecution, replayDefinition, type ExecutionExport, type ReplayResult } from "./replay.ts";

export interface DrassosConfig {
  databaseUrl?: string;
  dataDir?: string;
  inMemory?: boolean;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  logLevel?: string;
  clock?: Clock;
  logger?: Logger;
  defaultAgentProvider?: AgentProvider;
  authProvider?: AuthProvider;
  workflows?: WorkflowDefinition[];
  app?: DrassosApp;
  tools?: ToolDefinition[];
  models?: Record<string, ModelProvider>;
  maxChildDepth?: number;
  orchestrationLimits?: OrchestrationLimits;
  controlPlane?: boolean;
  concurrency?: number;
  workerQueues?: string[];
  workerToken?: string;
  observability?: ObservabilityConfig;
  enforceVersions?: boolean;
  allowReplace?: boolean;
}

export interface ReplayQuery {
  workflow?: string;
  version?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  execution?: string;
}

export interface Drassos {
  db: DbClient;
  store: Store;
  registry: WorkflowRegistry;
  agents: AgentRegistry;
  executor: Executor;
  notifier: WorkNotifier;
  logger: Logger;
  worker: Worker;
  mcp: McpManager;
  models: ModelRegistry;
  tools: ToolRegistry;
  capabilities: CapabilityRegistry;
  controlPlane: WorkerControlPlane;
  observability: Observability;
  tool(name: string, definition: Omit<ToolDefinition, "name" | "execute"> & { handler?: ToolDefinition["execute"]; execute?: ToolDefinition["execute"] }): void;
  signal(runId: string, name: string, payload?: unknown, options?: { id?: string }): Promise<{ signalId: string; duplicate: boolean }>;
  completeInteraction(runId: string, interactionId: string, decision: HumanDecision | Record<string, unknown>): Promise<HumanInteraction>;
  getPendingInteractions(runId?: string): Promise<HumanInteraction[]>;
  getInteraction(runId: string, interactionId: string): Promise<HumanInteraction | null>;
  listPendingInteractions(): Promise<HumanInteraction[]>;
  getExecution(executionId: string): Promise<ExecutionMetadata | null>;
  getExecutionTree(executionId: string): Promise<ExecutionNode>;
  cancelExecution(executionId: string, reason?: string): Promise<unknown>;
  exportExecution(runId: string): Promise<ExecutionExport>;
  replay(
    source: string | ExecutionExport,
    options?: { version?: string; definition?: WorkflowDefinition },
  ): Promise<ReplayResult>;
  replayMany(
    query: ReplayQuery,
    options?: { version?: string; definition?: WorkflowDefinition },
  ): Promise<{
    results: ReplayResult[];
    compatible: number;
    divergent: number;
    kinds: Record<string, number>;
  }>;
  requiredWorkflows(): Promise<Array<{ workflowName: string; version: string; active: number }>>;
  startWorker(): Promise<void>;
  stop(): Promise<void>;
}

export async function createDrassos(config: DrassosConfig = {}): Promise<Drassos> {
  const dataDir = resolve(config.dataDir ?? process.env.DRASSOS_DATA_DIR ?? ".drassos");
  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl && !config.inMemory) {
    await mkdir(dataDir, { recursive: true });
  }
  const { client } = await createDbClient({
    databaseUrl: config.inMemory ? undefined : databaseUrl,
    dataDir: config.inMemory ? undefined : resolve(dataDir, "pglite"),
  });
  await migrate(client);
  const store = new Store(client);
  const registry = new WorkflowRegistry({
    allowReplace: config.allowReplace,
    enforceVersions: config.enforceVersions,
  });
  const agentRegistry = new AgentRegistry();
  const notifier = new WorkNotifier();
  const mcp = new McpManager();
  const toolRegistry = new ToolRegistry();
  const models = new ModelRegistry();
  const capabilities = new CapabilityRegistry();
  const authProvider = config.authProvider ?? envAuthProvider;
  const logger = config.logger ?? createLogger({ level: config.logLevel });
  const defaultAgentProvider =
    config.defaultAgentProvider ??
    config.app?.defaultAgentProvider ??
    defaultProviderFromEnv();

  for (const definition of [...(config.app?.tools ?? []), ...(config.tools ?? [])]) {
    toolRegistry.register(definition);
    capabilities.register(localToolCapability(definition));
  }
  if (config.app?.models) {
    for (const [name, provider] of Object.entries(config.app.models)) {
      models.register(name, provider);
    }
  }
  if (config.models) {
    for (const [name, provider] of Object.entries(config.models)) {
      models.register(name, provider);
    }
  }
  if (defaultAgentProvider && "generate" in defaultAgentProvider && !models.has(defaultAgentProvider.name)) {
    models.register(defaultAgentProvider.name, defaultAgentProvider as ModelProvider);
  }

  const workflows = [...(config.app?.workflows ?? []), ...(config.workflows ?? [])];
  for (const workflow of workflows) {
    registry.register(workflow);
    await store.registerWorkflow(workflow.name, workflow.version);
    capabilities.register(localWorkflowCapability(workflow));
  }
  for (const definition of config.app?.agents ?? []) {
    agentRegistry.register(definition);
    capabilities.register(localAgentCapability(definition));
  }

  const workerId = config.workerId ?? process.env.DRASSOS_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;
  const executor = new Executor({
    store,
    registry,
    clock: config.clock ?? systemClock,
    logger,
    notifier,
    defaultAgentProvider,
    mcp,
    models,
    toolRegistry,
    agentRegistry,
    authProvider,
    maxChildDepth: config.maxChildDepth ?? config.orchestrationLimits?.maxDepth,
    orchestrationLimits: config.orchestrationLimits,
    workerId,
  });
  const leaseMs = config.leaseMs ?? Number(process.env.DRASSOS_LEASE_MS ?? 30_000);
  const workerToken = config.workerToken ?? process.env.DRASSOS_WORKER_TOKEN;
  const controlPlane = new WorkerControlPlane({
    store,
    notifier,
    logger,
    leaseMs,
    workerToken,
  });
  const worker = new Worker({
    id: workerId,
    store,
    executor,
    notifier,
    logger,
    leaseMs,
    pollMs: config.pollMs ?? 200,
    concurrency: config.concurrency,
    queues: config.workerQueues,
    types: config.controlPlane ? ["execute_run", "fire_timer"] : undefined,
    workerToken,
    registry,
  });
  const observability = new Observability(store, config.observability);

  async function bundleFromStore(runId: string): Promise<ExecutionExport> {
    const run = await store.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    const [history, steps, deterministicValues] = await Promise.all([
      store.listHistory(runId),
      store.listSteps(runId),
      store.listDeterministicValues(runId),
    ]);
    return exportExecution({
      run,
      history,
      steps,
      deterministicValues: deterministicValues.map((item) => ({
        kind: item.kind as "now" | "random" | "uuid",
        occurrence: item.occurrence,
        value: item.value as never,
      })),
    });
  }

  async function persistReplay(result: ReplayResult): Promise<void> {
    await store.insertReplayRecord({
      runId: result.executionId,
      recordedVersion: result.recordedVersion,
      testedVersion: result.testedVersion,
      status: result.ok ? "ok" : "divergent",
      eventsReplayed: result.eventsReplayed,
      durationMs: result.durationMs,
      divergences: result.divergences,
    });
    logger.info(
      {
        executionId: result.executionId,
        workflowName: result.workflowName,
        workflowVersion: result.recordedVersion,
        replay: true,
        historySequence: result.divergences[0]?.historySequence ?? null,
        ok: result.ok,
      },
      result.ok ? "replay completed" : "replay divergent",
    );
  }

  async function replaySource(
    source: string | ExecutionExport,
    options?: { version?: string; definition?: WorkflowDefinition },
  ): Promise<ReplayResult> {
    const bundle = typeof source === "string" ? await bundleFromStore(source) : source;
    const definition =
      options?.definition ?? registry.get(bundle.execution.workflow, options?.version);
    const result = await replayDefinition(definition, bundle);
    await persistReplay(result).catch(() => undefined);
    return result;
  }

  return {
    db: client,
    store,
    registry,
    agents: agentRegistry,
    executor,
    notifier,
    logger,
    worker,
    mcp,
    models,
    tools: toolRegistry,
    capabilities,
    controlPlane,
    observability,
    tool(name, definition) {
      const execute = definition.execute ?? definition.handler;
      if (!execute) {
        throw new Error(`Tool "${name}" requires execute or handler`);
      }
      const registered = { ...definition, name, execute, source: "local" as const };
      toolRegistry.register(registered);
      capabilities.register(localToolCapability(registered));
    },
    signal: (runId, name, payload, options) => executor.signal(runId, name, payload ?? {}, options),
    completeInteraction: (runId, interactionId, decision) =>
      executor.completeInteraction(runId, interactionId, decision),
    getPendingInteractions: (runId) => executor.getPendingInteractions(runId),
    getInteraction: (runId, interactionId) => executor.getInteraction(runId, interactionId),
    listPendingInteractions: () => executor.getPendingInteractions(),
    getExecution: (executionId) => executor.getExecution(executionId),
    getExecutionTree: (executionId) => executor.getExecutionTree(executionId),
    cancelExecution: (executionId, reason) => executor.cancelExecution(executionId, reason),
    exportExecution: (runId) => bundleFromStore(runId),
    replay: replaySource,
    async replayMany(query, options) {
      if (query.execution) {
        const single = await replaySource(query.execution, options);
        return summarizeReplays([single]);
      }
      const listed = await store.queryRuns({
        workflow: query.workflow,
        version: query.version,
        status: query.status,
        from: query.from,
        to: query.to,
        limit: Math.min(5_000, Math.max(1, query.limit ?? 100)),
        offset: 0,
      });
      const results: ReplayResult[] = [];
      for (const run of listed.rows) {
        results.push(await replaySource(run.id, options));
      }
      return summarizeReplays(results);
    },
    requiredWorkflows: () => store.listActiveVersionCounts(),
    startWorker: () => worker.start(),
    stop: async () => {
      await worker.stop();
      await mcp.close();
      await client.close();
    },
  };
}

function summarizeReplays(results: ReplayResult[]): {
  results: ReplayResult[];
  compatible: number;
  divergent: number;
  kinds: Record<string, number>;
} {
  const kinds: Record<string, number> = {};
  let compatible = 0;
  let divergent = 0;
  for (const result of results) {
    if (result.ok) {
      compatible += 1;
    } else {
      divergent += 1;
      for (const item of result.divergences) {
        kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
      }
    }
  }
  return { results, compatible, divergent, kinds };
}

function defaultProviderFromEnv(): AgentProvider | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return undefined;
  }
  return new OpenAIAgentProvider({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
    model: process.env.OPENAI_MODEL,
  });
}
