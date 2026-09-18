import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "../core/types.ts";
import { createDbClient, type DbClient } from "../persistence/client.ts";
import { migrate } from "../persistence/migrate.ts";
import { Store } from "../persistence/store.ts";
import { OpenAIAgentProvider } from "../agents/providers.ts";
import type { AgentProvider, DrassosApp, ToolDefinition, WorkflowDefinition } from "../sdk/types.ts";
import { Executor } from "./executor.ts";
import { createLogger, type Logger } from "./logger.ts";
import { WorkNotifier } from "./notifier.ts";
import { WorkflowRegistry } from "./registry.ts";
import { Worker } from "./worker.ts";
import { McpManager } from "./mcp.ts";
import { ModelRegistry } from "../models/model-registry.ts";
import type { ModelProvider } from "../models/model-types.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";

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
  workflows?: WorkflowDefinition[];
  app?: DrassosApp;
  tools?: ToolDefinition[];
  models?: Record<string, ModelProvider>;
  maxChildDepth?: number;
}

export interface Drassos {
  db: DbClient;
  store: Store;
  registry: WorkflowRegistry;
  executor: Executor;
  notifier: WorkNotifier;
  logger: Logger;
  worker: Worker;
  mcp: McpManager;
  models: ModelRegistry;
  tools: ToolRegistry;
  tool(name: string, definition: Omit<ToolDefinition, "name" | "execute"> & { handler?: ToolDefinition["execute"]; execute?: ToolDefinition["execute"] }): void;
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
  const registry = new WorkflowRegistry();
  const notifier = new WorkNotifier();
  const mcp = new McpManager();
  const toolRegistry = new ToolRegistry();
  const models = new ModelRegistry();
  const logger = config.logger ?? createLogger({ level: config.logLevel });
  const defaultAgentProvider =
    config.defaultAgentProvider ??
    config.app?.defaultAgentProvider ??
    defaultProviderFromEnv();

  for (const definition of [...(config.app?.tools ?? []), ...(config.tools ?? [])]) {
    toolRegistry.register(definition);
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
  }

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
    maxChildDepth: config.maxChildDepth,
  });
  const worker = new Worker({
    id: config.workerId ?? process.env.DRASSOS_WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`,
    store,
    executor,
    notifier,
    logger,
    leaseMs: config.leaseMs ?? Number(process.env.DRASSOS_LEASE_MS ?? 30_000),
    pollMs: config.pollMs ?? 200,
  });

  return {
    db: client,
    store,
    registry,
    executor,
    notifier,
    logger,
    worker,
    mcp,
    models,
    tools: toolRegistry,
    tool(name, definition) {
      const execute = definition.execute ?? definition.handler;
      if (!execute) {
        throw new Error(`Tool "${name}" requires execute or handler`);
      }
      toolRegistry.register({ ...definition, name, execute, source: "local" });
    },
    startWorker: () => worker.start(),
    stop: async () => {
      await worker.stop();
      await mcp.close();
      await client.close();
    },
  };
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
