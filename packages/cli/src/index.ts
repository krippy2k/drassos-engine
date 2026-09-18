import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { createDrassos, defineApp, type Drassos, type DrassosApp } from "@drassos/engine";
import { createApi, listenApi } from "@drassos/api";
import refundApp from "@drassos/example-refund";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("drassos").description("Drassos durable workflow engine").version("0.2.0");
  program.showHelpAfterError();

  program
    .command("dev")
    .description("Start the API, a local worker, and the console")
    .option("-p, --port <port>", "API port", process.env.DRASSOS_PORT ?? "3100")
    .option("--entry <file>", "Workflow module exporting defineApp() default")
    .option("--no-console", "Do not serve the web console")
    .option("--data-dir <dir>", "Local PGlite data directory")
    .action(async (opts: { port: string; entry?: string; console: boolean; dataDir?: string }) => {
      const app = await loadApp(opts.entry);
      const drassos = await createDrassos({
        app,
        dataDir: opts.dataDir,
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
    .option("--entry <file>", "Workflow module exporting defineApp() default")
    .option("--data-dir <dir>", "Local PGlite data directory")
    .action(async (opts: { entry?: string; dataDir?: string }) => {
      const app = await loadApp(opts.entry);
      const drassos = await createDrassos({ app, dataDir: opts.dataDir });
      await drassos.startWorker();
      drassos.logger.info({ workerId: drassos.worker.id }, "worker running");
      const shutdown = async () => {
        await drassos.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    });

  program
    .command("workflows")
    .description("List registered workflows")
    .option("--entry <file>")
    .option("--data-dir <dir>")
    .action(async (opts: { entry?: string; dataDir?: string }) => {
      const { drassos, close } = await openEphemeral(opts);
      try {
        for (const workflow of drassos.registry.list()) {
          process.stdout.write(`${workflow.name}  v${workflow.version}\n`);
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
    .action(async (workflow: string, opts: { input: string; entry?: string; dataDir?: string; wait?: boolean }) => {
      const app = await loadApp(opts.entry);
      const drassos = await createDrassos({ app, dataDir: opts.dataDir });
      await drassos.startWorker();
      try {
        const input = JSON.parse(opts.input) as unknown;
        const run = await drassos.executor.startRun(workflow, input);
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
  const apps: DrassosApp[] = [refundApp];
  try {
    const issue = (await import("@drassos/example-issue-resolution")) as { default?: DrassosApp };
    if (issue.default?.workflows) {
      apps.push(issue.default);
    }
  } catch {
    // optional until the example package is installed
  }
  return defineApp({
    workflows: apps.flatMap((app) => app.workflows),
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
