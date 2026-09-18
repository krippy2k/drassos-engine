import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { redactSecrets, type Drassos } from "@drassos/engine";
import {
  DrassosError,
  HumanTaskNotFoundError,
  IncompatibleWorkerProtocolError,
  InteractionAlreadyCompletedError,
  InteractionNotFoundError,
  RunNotFoundError,
  SignalNotAllowedError,
  StaleLeaseError,
  TaskPayloadTooLargeError,
  UnknownWorkflowError,
  WorkerAuthError,
  WorkflowNotFoundError,
} from "@drassos/engine";
import { openApiDocument } from "./openapi.ts";

export interface ApiOptions {
  drassos: Drassos;
  consoleDir?: string;
  workerToken?: string;
}

export function createApi(options: ApiOptions) {
  const { drassos } = options;
  const app = new Hono();
  app.use("*", cors());

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/openapi.json", (c) => c.json(openApiDocument));

  app.get("/workflows", async (c) => {
    const grouped = drassos.registry.grouped().map((group) => ({
      name: group.name,
      version: group.defaultVersion,
      versions: group.versions,
      defaultVersion: group.defaultVersion,
    }));
    return c.json({ workflows: grouped });
  });

  app.get("/workflows/required", async (c) => {
    const required = await drassos.requiredWorkflows();
    return c.json({ required });
  });

  app.get("/workflows/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const versions = drassos.registry.listVersions(name);
      if (versions.length === 0) {
        const workflow = drassos.registry.get(name);
        return c.json({ name: workflow.name, version: workflow.version, versions: [workflow.version] });
      }
      const group = drassos.registry.grouped().find((item) => item.name === name);
      return c.json({
        name,
        version: group?.defaultVersion ?? versions[0]?.version,
        versions: versions.map((item) => item.version),
        defaultVersion: group?.defaultVersion,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/executions/:id", async (c) => {
    const execution = await drassos.getExecution(c.req.param("id"));
    if (!execution) {
      return c.json(apiError("RUN_NOT_FOUND", "Execution not found"), 404);
    }
    return c.json(execution);
  });

  app.get("/executions/:id/tree", async (c) => {
    try {
      const tree = await drassos.getExecutionTree(c.req.param("id"));
      return c.json({ tree });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/executions/:id/cancel", async (c) => {
    const body = await readJson(c);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    try {
      const result = await drassos.cancelExecution(c.req.param("id"), reason);
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/runs/:id/tree", async (c) => {
    try {
      const tree = await drassos.getExecutionTree(c.req.param("id"));
      return c.json({ tree });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/runs/:id/children", async (c) => {
    const run = await drassos.store.getRun(c.req.param("id"));
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    const children = await drassos.store.listChildren(run.id);
    return c.json({ runId: run.id, children });
  });

  app.get("/runs/:id/agents", async (c) => {
    const run = await drassos.store.getRun(c.req.param("id"));
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    const agents = await drassos.store.listAgentRuns(run.id);
    return c.json({ runId: run.id, agents });
  });

  app.get("/agents/:id", async (c) => {
    const detail = await drassos.executor.inspectAgentRun(c.req.param("id"));
    if (!detail) {
      return c.json(apiError("AGENT_RUN_NOT_FOUND", "Agent run not found"), 404);
    }
    return c.json(detail);
  });

  app.get("/tool-calls/:id", async (c) => {
    const toolCall = await drassos.store.getToolCall(c.req.param("id"));
    if (!toolCall) {
      return c.json(apiError("TOOL_CALL_NOT_FOUND", "Tool call not found"), 404);
    }
    return c.json(toolCall);
  });

  app.post("/workflows/:name/runs", async (c) => {
    const name = c.req.param("name");
    const body = await readJson(c);
    const input = "input" in body ? body.input : body;
    try {
      const run = await drassos.executor.startRun(name, input, undefined, {
        version: typeof body.version === "string" ? body.version : undefined,
      });
      return c.json(run, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/runs", async (c) => {
    const listed = await drassos.observability.listRuns({
      workflow: c.req.query("workflow") ?? undefined,
      status: c.req.query("status") ?? undefined,
      agent: c.req.query("agent") ?? undefined,
      worker: c.req.query("worker") ?? undefined,
      from: c.req.query("from") ?? undefined,
      to: c.req.query("to") ?? undefined,
      failed: c.req.query("failed") === "true",
      minDurationMs: c.req.query("minDurationMs") ? Number(c.req.query("minDurationMs")) : undefined,
      maxDurationMs: c.req.query("maxDurationMs") ? Number(c.req.query("maxDurationMs")) : undefined,
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
    });
    return c.json({ runs: listed.runs, total: listed.total, limit: listed.limit, offset: listed.offset });
  });

  app.get("/runs/:id", async (c) => {
    const detail = await drassos.executor.inspectRun(c.req.param("id"));
    if (!detail) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    return c.json(detail);
  });

  app.get("/runs/:id/history", async (c) => {
    const run = await drassos.store.getRun(c.req.param("id"));
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    const history = await drassos.store.listHistory(run.id);
    return c.json({ runId: run.id, history });
  });

  app.get("/runs/:id/events", async (c) => {
    const run = await drassos.store.getRun(c.req.param("id"));
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    const afterSeq = c.req.query("after") ? Number(c.req.query("after")) : undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const history = await drassos.store.listHistory(run.id, { afterSeq, limit });
    return c.json({ runId: run.id, events: history, history });
  });

  app.get("/runs/:id/trace", async (c) => {
    const trace = await drassos.observability.trace(c.req.param("id"));
    if (!trace) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    return c.json({ trace });
  });

  app.get("/runs/:id/graph", async (c) => {
    const graph = await drassos.observability.graph(c.req.param("id"));
    if (!graph) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    return c.json(graph);
  });

  app.get("/runs/:id/logs", async (c) => {
    const run = await drassos.store.getRun(c.req.param("id"));
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    const history = await drassos.store.listHistory(run.id);
    const logs = history.map((event) => ({
      timestamp: event.timestamp,
      runId: run.id,
      type: event.type,
      message: event.type,
      seq: event.seq,
      operationId:
        typeof event.payload === "object" && event.payload && "stepId" in event.payload
          ? String((event.payload as { stepId?: string }).stepId ?? "")
          : event.id,
      payload: redactSecrets(event.payload),
    }));
    return c.json({ runId: run.id, logs });
  });

  app.get("/runs/:id/snapshot", async (c) => {
    const seq = Number(c.req.query("seq") ?? 0);
    const snapshot = await drassos.observability.snapshot(c.req.param("id"), seq);
    if (!snapshot) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    return c.json(snapshot);
  });

  app.get("/runs/:id/export", async (c) => {
    try {
      const bundle = await drassos.exportExecution(c.req.param("id"));
      return c.json(bundle);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/runs/:id/replay", async (c) => {
    const body = await readJson(c);
    try {
      const version = typeof body.version === "string" ? body.version : undefined;
      const result = await drassos.replay(c.req.param("id"), { version });
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/runs/:id/replays", async (c) => {
    const run = await drassos.store.getRun(c.req.param("id"));
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    const replays = await drassos.store.listReplayRecords(run.id);
    return c.json({ runId: run.id, replays });
  });

  app.post("/runs/:id/fork", async (c) => {
    const body = await readJson(c);
    const seq = Number(body.seq ?? 0);
    try {
      const run = await drassos.executor.forkRun(c.req.param("id"), seq);
      return c.json(run, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/runs/:id/stream", async (c) => {
    const runId = c.req.param("id");
    const run = await drassos.store.getRun(runId);
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    let after = Number(c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      const abort = c.req.raw.signal;
      while (!abort.aborted) {
        const events = await drassos.store.listHistory(runId, { afterSeq: after, limit: 200 });
        for (const event of events) {
          after = event.seq;
          await stream.writeSSE({
            id: String(event.seq),
            event: "history",
            data: JSON.stringify(event),
          });
          await stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: JSON.stringify(event),
          });
        }
        const current = await drassos.store.getRun(runId);
        await stream.writeSSE({
          event: "run.status",
          data: JSON.stringify({
            status: current?.status ?? "UNKNOWN",
            waitType: current?.waitType ?? null,
          }),
        });
        if (current && (current.status === "COMPLETED" || current.status === "FAILED" || current.status === "CANCELLED")) {
          break;
        }
        await drassos.notifier.wait(400);
      }
    });
  });

  app.get("/metrics/overview", async (c) => {
    const metrics = await drassos.observability.metrics();
    return c.json(metrics);
  });

  for (const prefix of ["/api"] as const) {
    app.get(`${prefix}/workflows`, (c) => app.request("/workflows", c.req.raw));
    app.get(`${prefix}/runs`, (c) => {
      const url = new URL(c.req.url);
      url.pathname = "/runs";
      return app.request(url, c.req.raw);
    });
    app.get(`${prefix}/runs/:id`, (c) => app.request(`/runs/${c.req.param("id")}`, c.req.raw));
    app.get(`${prefix}/runs/:id/events`, (c) => {
      const url = new URL(c.req.url);
      url.pathname = `/runs/${c.req.param("id")}/events`;
      return app.request(url, c.req.raw);
    });
    app.get(`${prefix}/runs/:id/trace`, (c) => app.request(`/runs/${c.req.param("id")}/trace`, c.req.raw));
    app.get(`${prefix}/runs/:id/graph`, (c) => app.request(`/runs/${c.req.param("id")}/graph`, c.req.raw));
    app.get(`${prefix}/runs/:id/logs`, (c) => app.request(`/runs/${c.req.param("id")}/logs`, c.req.raw));
    app.get(`${prefix}/runs/:id/snapshot`, (c) => {
      const url = new URL(c.req.url);
      url.pathname = `/runs/${c.req.param("id")}/snapshot`;
      return app.request(url, c.req.raw);
    });
    app.get(`${prefix}/runs/:id/stream`, (c) => {
      const url = new URL(c.req.url);
      url.pathname = `/runs/${c.req.param("id")}/stream`;
      return app.request(url, c.req.raw);
    });
    app.post(`${prefix}/runs/:id/fork`, (c) => app.request(`/runs/${c.req.param("id")}/fork`, c.req.raw));
    app.get(`${prefix}/workflows/:name`, (c) => app.request(`/workflows/${c.req.param("name")}`, c.req.raw));
    app.get(`${prefix}/metrics/overview`, (c) => app.request("/metrics/overview", c.req.raw));
  }

  app.post("/runs/:id/cancel", async (c) => {
    const body = await readJson(c);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    try {
      const run = await drassos.executor.cancelRun(c.req.param("id"), reason);
      return c.json(run);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/runs/:id/events", async (c) => {
    const body = await readJson(c);
    if (typeof body.type !== "string") {
      return c.json(apiError("INVALID_REQUEST", "Event type is required"), 400);
    }
    try {
      const result = await drassos.executor.deliverEvent(
        c.req.param("id"),
        body.type,
        body.data ?? {},
        typeof body.id === "string" ? body.id : undefined,
      );
      return c.json(result, 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/workflows/:workflowId/signals/:signalName", async (c) => {
    const body = await readJson(c);
    const payload = "payload" in body ? body.payload : body;
    try {
      const result = await drassos.signal(c.req.param("workflowId"), c.req.param("signalName"), payload, {
        id: typeof body.id === "string" ? body.id : undefined,
      });
      return c.json(result, result.duplicate ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/interactions", async (c) => {
    const runId = c.req.query("workflowId") ?? c.req.query("runId") ?? undefined;
    const interactions = await drassos.getPendingInteractions(runId);
    return c.json({ interactions });
  });

  app.get("/workflows/:workflowId/interactions", async (c) => {
    const run = await drassos.store.getRun(c.req.param("workflowId"));
    if (!run) {
      return c.json(apiError("RUN_NOT_FOUND", "Workflow run not found"), 404);
    }
    const interactions = await drassos.store.listInteractions({ runId: run.id });
    return c.json({ workflowId: run.id, interactions });
  });

  app.get("/workflows/:workflowId/interactions/:interactionId", async (c) => {
    const interaction = await drassos.getInteraction(c.req.param("workflowId"), c.req.param("interactionId"));
    if (!interaction) {
      return c.json(apiError("INTERACTION_NOT_FOUND", "Human interaction not found"), 404);
    }
    return c.json(interaction);
  });

  app.post("/workflows/:workflowId/interactions/:interactionId/complete", async (c) => {
    const body = await readJson(c);
    try {
      const interaction = await drassos.completeInteraction(
        c.req.param("workflowId"),
        c.req.param("interactionId"),
        body,
      );
      return c.json(interaction);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/human-tasks", async (c) => {
    const status = c.req.query("status") as "pending" | "completed" | "cancelled" | undefined;
    const tasks = await drassos.store.listHumanTasks(status ? { status } : undefined);
    return c.json({ tasks });
  });

  app.get("/human-tasks/:id", async (c) => {
    const task = await drassos.store.getHumanTask(c.req.param("id"));
    if (!task) {
      return c.json(apiError("HUMAN_TASK_NOT_FOUND", "Human task not found"), 404);
    }
    return c.json(task);
  });

  app.post("/human-tasks/:id/complete", async (c) => {
    const body = await readJson(c);
    const response =
      body && typeof body === "object" && "response" in body ? body.response : (body ?? {});
    try {
      const task = await drassos.executor.completeHumanTask(c.req.param("id"), response);
      return c.json(task);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  const plane = drassos.controlPlane;

  app.post("/worker/register", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      const result = await plane.register({
        protocolVersion: stringField(body.protocolVersion) ?? c.req.header("x-drassos-worker-protocol") ?? undefined,
        workerId: requiredString(body.workerId, "workerId"),
        queues: stringArray(body.queues),
        concurrency: Number(body.concurrency ?? 1),
        capabilities: stringArray(body.capabilities),
        version: stringField(body.version),
        hostname: stringField(body.hostname),
        processId: body.processId === undefined ? undefined : Number(body.processId),
      });
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/worker/heartbeat", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      const result = await plane.heartbeat({
        protocolVersion: stringField(body.protocolVersion) ?? c.req.header("x-drassos-worker-protocol") ?? undefined,
        workerId: requiredString(body.workerId, "workerId"),
        availableSlots: body.availableSlots === undefined ? undefined : Number(body.availableSlots),
        activeTasks: body.activeTasks === undefined ? undefined : Number(body.activeTasks),
        status: body.status === "draining" || body.status === "offline" || body.status === "online" ? body.status : undefined,
      });
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/worker/drain", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      return c.json(await plane.drain(requiredString(body.workerId, "workerId"), stringField(body.protocolVersion)));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/worker/disconnect", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      return c.json(await plane.disconnect(requiredString(body.workerId, "workerId"), stringField(body.protocolVersion)));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/worker/tasks/poll", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      const result = await plane.poll({
        protocolVersion: stringField(body.protocolVersion) ?? c.req.header("x-drassos-worker-protocol") ?? undefined,
        workerId: requiredString(body.workerId, "workerId"),
        queues: stringArray(body.queues),
        availableSlots: Number(body.availableSlots ?? 1),
        waitMs: body.waitMs === undefined ? undefined : Number(body.waitMs),
      });
      return c.json(result);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/worker/tasks/:taskId/heartbeat", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      return c.json(
        await plane.heartbeatTask(c.req.param("taskId"), {
          protocolVersion: stringField(body.protocolVersion),
          workerId: requiredString(body.workerId, "workerId"),
          leaseToken: requiredString(body.leaseToken, "leaseToken"),
          progress: body.progress as never,
        }),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/worker/tasks/:taskId/complete", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      return c.json(
        await plane.complete(c.req.param("taskId"), {
          protocolVersion: stringField(body.protocolVersion),
          workerId: requiredString(body.workerId, "workerId"),
          leaseToken: requiredString(body.leaseToken, "leaseToken"),
          result: ("result" in body ? body.result : null) as never,
        }),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/worker/tasks/:taskId/fail", async (c) => {
    try {
      plane.assertAuth(c.req.header("authorization"));
      const body = await readJson(c);
      const error = isRecord(body.error) ? body.error : {};
      return c.json(
        await plane.fail(c.req.param("taskId"), {
          protocolVersion: stringField(body.protocolVersion),
          workerId: requiredString(body.workerId, "workerId"),
          leaseToken: requiredString(body.leaseToken, "leaseToken"),
          error: {
            type: stringField(error.type),
            name: stringField(error.name),
            message: requiredString(error.message ?? "task failed", "error.message"),
            retryable: error.retryable === undefined ? undefined : Boolean(error.retryable),
          },
        }),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/metrics/queues", async (c) => {
    const queues = await drassos.store.getQueueMetrics();
    return c.json({ queues });
  });

  app.get("/workers", async (c) => {
    const workers = await drassos.store.listWorkers();
    return c.json({ workers });
  });

  if (options.consoleDir) {
    app.use("/*", serveStatic({ root: options.consoleDir }));
  }

  return app;
}

export async function listenApi(
  app: ReturnType<typeof createApi>,
  options: { port: number; hostname?: string },
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: options.port, hostname: options.hostname ?? "127.0.0.1" },
      (info) => {
        resolve({
          port: info.port,
          close: async () => {
            await new Promise<void>((done) => {
              server.close(() => done());
            });
          },
        });
      },
    );
  });
}

async function readJson(c: {
  req: { json: () => Promise<unknown>; header: (name: string) => string | undefined };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return { value: body };
  } catch {
    return {};
  }
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

function errorResponse(c: { json: (value: unknown, status?: number) => Response }, error: unknown) {
  if (error instanceof WorkflowNotFoundError || error instanceof UnknownWorkflowError) {
    return c.json(apiError(error.code, error.message), 404);
  }
  if (error instanceof RunNotFoundError || error instanceof HumanTaskNotFoundError || error instanceof InteractionNotFoundError) {
    return c.json(apiError(error.code, error.message), 404);
  }
  if (error instanceof SignalNotAllowedError || error instanceof InteractionAlreadyCompletedError || error instanceof StaleLeaseError) {
    return c.json(apiError(error.code, error.message), 409);
  }
  if (error instanceof WorkerAuthError) {
    return c.json(apiError(error.code, error.message), 401);
  }
  if (error instanceof IncompatibleWorkerProtocolError) {
    return c.json(apiError(error.code, error.message), 400);
  }
  if (error instanceof TaskPayloadTooLargeError) {
    return c.json(apiError(error.code, error.message), 413);
  }
  if (error instanceof DrassosError) {
    return c.json(apiError(error.code, error.message), error.isInternal ? 500 : 400);
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json(apiError("INTERNAL_ERROR", message), 500);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DrassosError(`${name} is required`, { code: "INVALID_REQUEST", isInternal: false });
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
