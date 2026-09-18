import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Drassos } from "@drassos/engine";
import {
  DrassosError,
  HumanTaskNotFoundError,
  RunNotFoundError,
  WorkflowNotFoundError,
} from "@drassos/engine";
import { openApiDocument } from "./openapi.ts";

export interface ApiOptions {
  drassos: Drassos;
  consoleDir?: string;
}

export function createApi(options: ApiOptions) {
  const { drassos } = options;
  const app = new Hono();
  app.use("*", cors());

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/openapi.json", (c) => c.json(openApiDocument));

  app.get("/workflows", async (c) => {
    const registered = drassos.registry.listAll().map((workflow) => ({
      name: workflow.name,
      version: workflow.version,
    }));
    return c.json({ workflows: registered });
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
      const run = await drassos.executor.startRun(name, input);
      return c.json(run, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/runs", async (c) => {
    const workflow = c.req.query("workflow") ?? undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    const runs = await drassos.store.listRuns({ workflow, limit });
    return c.json({ runs });
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
  if (error instanceof WorkflowNotFoundError) {
    return c.json(apiError(error.code, error.message), 404);
  }
  if (error instanceof RunNotFoundError || error instanceof HumanTaskNotFoundError) {
    return c.json(apiError(error.code, error.message), 404);
  }
  if (error instanceof DrassosError) {
    return c.json(apiError(error.code, error.message), error.isInternal ? 500 : 400);
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json(apiError("INTERNAL_ERROR", message), 500);
}
