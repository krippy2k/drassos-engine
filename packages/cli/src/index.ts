import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import {
  createDrassos,
  defineApp,
  DrassosWorker,
  replayDefinition,
  type ActivityHandler,
  type Drassos,
  type DrassosApp,
  type ExecutionExport,
  type ReplayResult,
  type WorkflowDefinition,
} from "@drassos/engine";
import { createApi, listenApi } from "@drassos/api";
import refundApp from "@drassos/example-refund";
import issueApp from "@drassos/example-issue-resolution";
import restaurantApp from "@drassos/example-restaurant-research";
import reportApp from "@drassos/example-report-approval";
import researchApp from "@drassos/example-multi-agent-research";
import interopApp from "@drassos/example-interop";
import distributedApp, { registerWorker as registerDistributedWorker } from "@drassos/example-distributed-workers";
import observabilityApp from "@drassos/example-observability-tour";
import rollingDeployApp from "@drassos/example-rolling-deploy";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("drassos").description("Drassos durable workflow engine").version("0.9.0");
  program.showHelpAfterError();

  program
    .command("dev")
    .description("Start the API, a local worker, and the console")
    .option("-p, --port <port>", "API port", process.env.DRASSOS_PORT ?? "3100")
    .option("--entry <file>", "Workflow module exporting defineApp() default")
    .option("--no-console", "Do not serve the web console")
    .option("--data-dir <dir>", "Local PGlite data directory")
    .option("--control-plane", "Only run orchestration locally; remote workers execute activities")
    .action(async (opts: { port: string; entry?: string; console: boolean; dataDir?: string; controlPlane?: boolean }) => {
      const app = await loadApp(opts.entry);
      const drassos = await createDrassos({
        app,
        dataDir: opts.dataDir,
        controlPlane: Boolean(opts.controlPlane),
      });
      await drassos.startWorker();
      const consoleDir = opts.console ? findConsoleDir() : undefined;
      if (opts.console && !consoleDir) {
        drassos.logger.warn(
          "Console build not found. Run `pnpm --filter @drassos/console build` to serve the UI.",
        );
      }
      const api = createApi({ drassos, consoleDir });
      const server = await listenApi(api, { port: Number(opts.port) });
      drassos.logger.info(
        {
          port: server.port,
          workflows: drassos.registry.list().map((item) => item.name),
          console: Boolean(consoleDir),
        },
        `Drassos listening on http://127.0.0.1:${server.port}`,
      );
      const shutdown = async () => {
        await server.close();
        await drassos.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    });

  program
    .command("worker")
    .description("Start a worker process")
    .option("--entry <file>", "Workflow module exporting defineApp() / registerWorker()")
    .option("--data-dir <dir>", "Local PGlite data directory")
    .option("--server <url>", "Remote Drassos server for the HTTP worker protocol")
    .option("--queues <queues>", "Comma-separated queues", "default")
    .option("--concurrency <n>", "Max concurrent tasks", "5")
    .option("--token <token>", "Worker bearer token")
    .option("--control-plane", "Only claim orchestration work")
    .action(
      async (opts: {
        entry?: string;
        dataDir?: string;
        server?: string;
        queues: string;
        concurrency: string;
        token?: string;
        controlPlane?: boolean;
      }) => {
        const queues = opts.queues.split(",").map((item) => item.trim()).filter(Boolean);
        if (opts.server) {
          const worker = new DrassosWorker({
            server: opts.server,
            token: opts.token ?? process.env.DRASSOS_WORKER_TOKEN,
            queues,
            concurrency: Number(opts.concurrency),
          });
          await attachWorkerHandlers(worker, opts.entry);
          await worker.start();
          const shutdown = async () => {
            await worker.stop();
            process.exit(0);
          };
          process.on("SIGINT", () => void shutdown());
          process.on("SIGTERM", () => void shutdown());
          return;
        }
        const app = await loadApp(opts.entry);
        const drassos = await createDrassos({
          app,
          dataDir: opts.dataDir,
          controlPlane: Boolean(opts.controlPlane),
          concurrency: Number(opts.concurrency),
          workerQueues: queues.length ? queues : undefined,
        });
        await attachWorkerHandlers(drassos.worker, opts.entry);
        await drassos.startWorker();
        drassos.logger.info({ workerId: drassos.worker.id, queues }, "worker running");
        const shutdown = async () => {
          await drassos.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());
      },
    );

  const workflowsCmd = program
    .command("workflows")
    .description("List registered workflows")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        for (const group of drassos.registry.grouped()) {
          process.stdout.write(`${group.name}  versions=${group.versions.join(",")}  default=${group.defaultVersion}\n`);
        }
      } finally {
        await close();
      }
    });

  workflowsCmd
    .command("required")
    .description("Show workflow versions still required by active executions")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const required = await drassos.requiredWorkflows();
        process.stdout.write("Workflow                 Version    Active Executions\n");
        for (const row of required) {
          process.stdout.write(
            `${row.workflowName.padEnd(24)}${row.version.padEnd(11)}${row.active}\n`,
          );
        }
      } finally {
        await close();
      }
    });

  program
    .command("runs")
    .description("List recent workflow runs")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .option("--limit <n>", "limit", "20")
    .action(async (opts: { entry?: string; dataDir?: string; limit: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const runs = await drassos.store.listRuns({ limit: Number(opts.limit) });
        for (const run of runs) {
          process.stdout.write(`${run.id}  ${run.workflowName}  ${run.status}\n`);
        }
      } finally {
        await close();
      }
    });

  program
    .command("run")
    .argument("<workflow>", "Workflow name")
    .option("--input <json>", "JSON input", "{}")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .option("--wait", "Wait until the run leaves RUNNING/PENDING", false)
    .option("--version <version>", "Workflow version")
    .action(async (workflow: string, opts: { input: string; entry?: string; dataDir?: string; wait?: boolean; version?: string }) => {
      const app = await loadApp(opts.entry);
      const drassos = await createDrassos({ app, dataDir: opts.dataDir });
      await drassos.startWorker();
      try {
        const input = JSON.parse(opts.input) as unknown;
        const run = await drassos.executor.startRun(workflow, input, undefined, { version: opts.version });
        process.stdout.write(`${run.id}\n`);
        if (opts.wait) {
          const finished = await waitForSettled(drassos, run.id);
          process.stdout.write(`${finished.status}\n`);
        }
      } finally {
        if (!opts.wait) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await drassos.stop();
      }
    });

  program
    .command("inspect")
    .argument("<runId>", "Run ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (runId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const detail = await drassos.executor.inspectRun(runId);
        if (!detail) {
          process.stderr.write(`Run not found: ${runId}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
      } finally {
        await close();
      }
    });

  program
    .command("tree")
    .argument("<executionId>", "Execution ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (executionId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const tree = await drassos.getExecutionTree(executionId);
        process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
      } finally {
        await close();
      }
    });

  program
    .command("cancel")
    .argument("<executionId>", "Execution ID")
    .option("--reason <text>")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (executionId: string, opts: { reason?: string; entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const result = await drassos.cancelExecution(executionId, opts.reason);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally {
        await close();
      }
    });

  program
    .command("history")
    .argument("<runId>", "Run ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (runId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const history = await drassos.store.listHistory(runId);
        for (const event of history) {
          process.stdout.write(`${event.seq}\t${event.timestamp}\t${event.type}\n`);
        }
      } finally {
        await close();
      }
    });

  const agents = program.command("agents").description("Inspect durable agent runs");
  agents
    .command("list")
    .argument("<runId>", "Workflow run ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (runId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const list = await drassos.store.listAgentRuns(runId);
        for (const agent of list) {
          process.stdout.write(
            `${agent.id}  ${agent.agentName}  ${agent.status}  turns=${agent.currentTurn}  tools=${agent.toolCallCount}  models=${agent.modelCallCount}\n`,
          );
        }
      } finally {
        await close();
      }
    });
  agents
    .command("show")
    .argument("<agentRunId>", "Agent run ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (agentRunId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const detail = await drassos.executor.inspectAgentRun(agentRunId);
        if (!detail) {
          process.stderr.write(`Agent run not found: ${agentRunId}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
      } finally {
        await close();
      }
    });

  const toolsCmd = program.command("tools").description("Inspect durable tool calls");
  toolsCmd
    .command("show")
    .argument("<toolCallId>", "Tool call ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (toolCallId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const toolCall = await drassos.store.getToolCall(toolCallId);
        if (!toolCall) {
          process.stderr.write(`Tool call not found: ${toolCallId}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`${JSON.stringify(toolCall, null, 2)}\n`);
      } finally {
        await close();
      }
    });

  program
    .command("children")
    .argument("<runId>", "Parent run ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (runId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const children = await drassos.store.listChildren(runId);
        for (const child of children) {
          process.stdout.write(
            `${child.id}  ${child.workflowName}@${child.workflowVersion}  ${child.status}\n`,
          );
        }
      } finally {
        await close();
      }
    });

  program
    .command("signal")
    .argument("<runId>", "Workflow run ID")
    .argument("<name>", "Signal name")
    .option("--data <json>", "JSON payload", "{}")
    .option("--id <id>", "Idempotency key")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (runId: string, name: string, opts: { data: string; id?: string; entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const payload = JSON.parse(opts.data) as unknown;
        const result = await drassos.signal(runId, name, payload, { id: opts.id });
        process.stdout.write(`${result.signalId}${result.duplicate ? "  duplicate" : ""}\n`);
      } finally {
        await close();
      }
    });

  program
    .command("interactions")
    .argument("[runId]", "Optional workflow run ID")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (runId: string | undefined, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const list = runId
          ? await drassos.store.listInteractions({ runId })
          : await drassos.listPendingInteractions();
        if (list.length === 0) {
          process.stdout.write("No interactions\n");
          return;
        }
        for (const item of list) {
          process.stdout.write(
            `${item.runId}  ${item.interactionId}  ${item.status}  ${item.title}\n`,
          );
        }
      } finally {
        await close();
      }
    });

  program
    .command("approve")
    .argument("<runId>", "Workflow run ID")
    .argument("<interactionId>", "Interaction id")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (runId: string, interactionId: string, opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const result = await drassos.completeInteraction(runId, interactionId, { outcome: "approved" });
        process.stdout.write(`${result.interactionId}  ${result.status}\n`);
      } finally {
        await close();
      }
    });

  const interactionCmd = program.command("interaction").description("Complete human interactions");
  interactionCmd
    .command("complete")
    .argument("<runId>", "Workflow run ID")
    .argument("<interactionId>", "Interaction id")
    .requiredOption("--outcome <outcome>", "approved | rejected | changes_requested")
    .option("--reason <text>")
    .option("--feedback <text>")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(
      async (
        runId: string,
        interactionId: string,
        opts: { outcome: string; reason?: string; feedback?: string; entry?: string; dataDir?: string },
      ) => {
        const { drassos, close } = await openEphemeral(opts);
        try {
          const result = await drassos.completeInteraction(runId, interactionId, {
            outcome: opts.outcome,
            reason: opts.reason,
            feedback: opts.feedback,
          });
          process.stdout.write(`${result.interactionId}  ${result.status}\n`);
        } finally {
          await close();
        }
      },
    );

  program
    .command("replay")
    .description("Replay an execution or exported history against workflow code")
    .argument("[target]", "Execution id or export JSON path")
    .option("--against <file>", "Workflow module to test")
    .option("--workflow <name>", "Filter by workflow name")
    .option("--version <version>", "Recorded version filter or candidate version")
    .option("--status <status>", "Filter runs by status")
    .option("--since <iso>", "Filter runs created at or after")
    .option("--until <iso>", "Filter runs created at or before")
    .option("--limit <n>", "Max histories", "100")
    .option("--execution <id>", "Replay a specific execution")
    .option("--json", "Machine-readable output")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(
      async (
        target: string | undefined,
        opts: {
          against?: string;
          workflow?: string;
          version?: string;
          status?: string;
          since?: string;
          until?: string;
          limit: string;
          execution?: string;
          json?: boolean;
          entry?: string;
          dataDir?: string;
        },
      ) => {
        const against = opts.against ? await loadDefinitions(opts.against) : undefined;
        const pick = (name: string, version?: string) => {
          const definitions = against ?? [];
          return (
            definitions.find((item) => item.name === name && (version ? item.version === version : true)) ??
            definitions.find((item) => item.name === name) ??
            definitions[0]
          );
        };
        if (target && isExportPath(target)) {
          const bundle = JSON.parse(await readFile(resolve(target), "utf8")) as ExecutionExport;
          const definition = pick(bundle.execution.workflow);
          if (!definition) {
            process.stderr.write("Provide --against with a matching workflow definition for offline replay.\n");
            process.exitCode = 1;
            return;
          }
          const result = await replayDefinition(definition, bundle);
          printReplay(result, Boolean(opts.json));
          if (!result.ok) {
            process.exitCode = 1;
          }
          return;
        }
        const { drassos, close } = await openEphemeral({ entry: opts.entry ?? opts.against, dataDir: opts.dataDir });
        try {
          const definition = against
            ? pick(opts.workflow ?? against[0]?.name ?? "", opts.version)
            : undefined;
          const executionId = target ?? opts.execution;
          if (executionId) {
            const result = await drassos.replay(executionId, against ? { definition } : { version: opts.version, definition });
            printReplay(result, Boolean(opts.json));
            if (!result.ok) {
              process.exitCode = 1;
            }
            return;
          }
          const batch = await drassos.replayMany(
            {
              workflow: opts.workflow,
              version: opts.version,
              status: opts.status,
              from: opts.since,
              to: opts.until,
              limit: Number(opts.limit),
              execution: opts.execution,
            },
            against ? { definition } : { version: opts.version, definition },
          );
          printReplayBatch(opts.workflow ?? definition?.name ?? "(all)", definition?.version ?? opts.version ?? "default", batch, Boolean(opts.json));
          if (batch.divergent > 0) {
            process.exitCode = 1;
          }
        } finally {
          await close();
        }
      },
    );

  const executionCmd = program.command("execution").description("Export and inspect executions");
  executionCmd
    .command("export")
    .argument("<executionId>", "Execution ID")
    .option("-o, --output <file>", "Write JSON to a file")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (executionId: string, opts: { output?: string; entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        const bundle = await drassos.exportExecution(executionId);
        const json = `${JSON.stringify(bundle, null, 2)}\n`;
        if (opts.output) {
          await writeFile(resolve(opts.output), json, "utf8");
        } else {
          process.stdout.write(json);
        }
      } finally {
        await close();
      }
    });

  await program.parseAsync(normalizeArgv(argv));
}

function normalizeArgv(argv: string[]): string[] {
  const entry = argv.findIndex((arg) =>
    /packages[\\/]cli[\\/]src[\\/](index|bin)\.ts$/.test(arg) || /bin[\\/]drassos\.mjs$/.test(arg),
  );
  if (entry >= 1) {
    return [argv[0] ?? "node", argv[entry]!, ...argv.slice(entry + 1)];
  }
  return argv;
}

async function openEphemeral(opts: { entry?: string; dataDir?: string }): Promise<{
  drassos: Drassos;
  close: () => Promise<void>;
}> {
  const app = await loadApp(opts.entry);
  const drassos = await createDrassos({ app, dataDir: opts.dataDir });
  return { drassos, close: () => drassos.stop() };
}

async function attachWorkerHandlers(
  worker: { activity: (name: string, handler: ActivityHandler) => unknown; agent: (name: string, handler: ActivityHandler) => unknown },
  entry?: string,
): Promise<void> {
  if (entry) {
    const url = pathToFileURL(resolve(entry)).href;
    const mod = (await import(url)) as { registerWorker?: (worker: unknown) => void };
    mod.registerWorker?.(worker);
    return;
  }
  registerDistributedWorker(worker as never);
}

async function loadApp(entry?: string): Promise<DrassosApp> {
  if (entry) {
    const url = pathToFileURL(resolve(entry)).href;
    const mod = (await import(url)) as { default?: DrassosApp; app?: DrassosApp };
    const app = mod.default ?? mod.app;
    if (!app?.workflows) {
      throw new Error(`Module ${entry} must default-export a defineApp() object`);
    }
    return app;
  }
  const apps: DrassosApp[] = [
    refundApp,
    issueApp,
    restaurantApp,
    reportApp,
    researchApp,
    interopApp,
    distributedApp,
    observabilityApp,
    rollingDeployApp,
  ];
  return defineApp({
    workflows: apps.flatMap((app) => app.workflows),
    agents: apps.flatMap((app) => app.agents ?? []),
    tools: apps.flatMap((app) => app.tools ?? []),
    models: Object.assign({}, ...apps.map((app) => app.models ?? {})),
    defaultAgentProvider: apps.find((app) => app.defaultAgentProvider)?.defaultAgentProvider,
  });
}

function findConsoleDir(): string | undefined {
  const candidates = [
    resolve(process.cwd(), "apps/console/dist"),
    resolve(process.cwd(), "../../apps/console/dist"),
  ];
  return candidates.find((dir) => existsSync(dir));
}

async function waitForSettled(drassos: Drassos, runId: string, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await drassos.store.getRun(runId);
    if (run && run.status !== "PENDING" && run.status !== "RUNNING") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

function isExportPath(value: string): boolean {
  return value.endsWith(".json") || existsSync(resolve(value));
}

async function loadDefinitions(entry: string): Promise<WorkflowDefinition[]> {
  const url = pathToFileURL(resolve(entry)).href;
  const mod = (await import(url)) as {
    default?: DrassosApp | WorkflowDefinition | WorkflowDefinition[];
    app?: DrassosApp;
    workflows?: WorkflowDefinition[];
  };
  if (mod.default && typeof mod.default === "object" && "workflows" in mod.default && Array.isArray(mod.default.workflows)) {
    return mod.default.workflows;
  }
  if (Array.isArray(mod.default)) {
    return mod.default;
  }
  if (mod.default && typeof mod.default === "object" && "fn" in mod.default && "name" in mod.default) {
    return [mod.default];
  }
  if (mod.app?.workflows) {
    return mod.app.workflows;
  }
  if (mod.workflows) {
    return mod.workflows;
  }
  throw new Error(`Module ${entry} must export workflow definitions`);
}

function printReplay(result: ReplayResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(result.ok ? "Replay successful\n\n" : "Replay divergent\n\n");
  process.stdout.write(`Execution: ${result.executionId}\n`);
  process.stdout.write(`Workflow: ${result.workflowName}\n`);
  process.stdout.write(`Recorded version: ${result.recordedVersion}\n`);
  process.stdout.write(`Tested version: ${result.testedVersion}\n`);
  process.stdout.write(`Events replayed: ${result.eventsReplayed}\n`);
  process.stdout.write(`Divergences: ${result.divergences.length}\n`);
  for (const item of result.divergences) {
    process.stdout.write(`\n${item.kind}\nExpected: ${item.expected}\nActual: ${item.actual}\n`);
  }
}

function printReplayBatch(
  workflow: string,
  candidate: string,
  batch: { results: ReplayResult[]; compatible: number; divergent: number; kinds: Record<string, number> },
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(batch)}\n`);
    return;
  }
  process.stdout.write("Replay Regression Report\n\n");
  process.stdout.write(`Workflow: ${workflow}\n`);
  process.stdout.write(`Candidate: ${candidate}\n\n`);
  process.stdout.write(`Histories tested: ${batch.results.length}\n\n`);
  process.stdout.write(`Compatible: ${batch.compatible}\n`);
  process.stdout.write(`Divergent: ${batch.divergent}\n`);
  if (batch.divergent > 0) {
    process.stdout.write("\nDivergences:\n\n");
    for (const [kind, count] of Object.entries(batch.kinds)) {
      process.stdout.write(`${kind.padEnd(24)}${count}\n`);
    }
  }
}
