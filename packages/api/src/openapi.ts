export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Drassos API",
    version: "0.2.0",
    description: "Minimal HTTP API for the Drassos durable orchestration engine.",
  },
  paths: {
    "/health": {
      get: { summary: "Health check", responses: { "200": { description: "OK" } } },
    },
    "/workflows": {
      get: { summary: "List registered workflows", responses: { "200": { description: "Workflow list" } } },
    },
    "/workflows/{name}/runs": {
      post: {
        summary: "Start a workflow run",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { input: { type: "object" } },
              },
            },
          },
        },
        responses: { "201": { description: "Run created" } },
      },
    },
    "/runs": {
      get: { summary: "List workflow runs", responses: { "200": { description: "Run list" } } },
    },
    "/runs/{id}": {
      get: {
        summary: "Get a workflow run and related execution data",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Run detail" }, "404": { description: "Not found" } },
      },
    },
    "/runs/{id}/history": {
      get: {
        summary: "Get append-only execution history",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "History" } },
      },
    },
    "/runs/{id}/cancel": {
      post: {
        summary: "Cancel a workflow run",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Cancelled" } },
      },
    },
    "/runs/{id}/events": {
      post: {
        summary: "Deliver an external event to a run",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["type"],
                properties: {
                  type: { type: "string" },
                  data: {},
                  id: { type: "string", description: "Optional delivery id for deduplication" },
                },
              },
            },
          },
        },
        responses: { "202": { description: "Accepted" } },
      },
    },
    "/runs/{id}/children": {
      get: {
        summary: "List child workflow runs",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Child runs" } },
      },
    },
    "/runs/{id}/agents": {
      get: {
        summary: "List agent runs for a workflow run",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Agent runs" } },
      },
    },
    "/agents/{id}": {
      get: {
        summary: "Inspect an agent run, turns, model calls, and tool calls",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Agent run detail" }, "404": { description: "Not found" } },
      },
    },
    "/tool-calls/{id}": {
      get: {
        summary: "Inspect a durable tool call",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Tool call" }, "404": { description: "Not found" } },
      },
    },
    "/human-tasks": {
      get: { summary: "List human tasks", responses: { "200": { description: "Task list" } } },
    },
    "/human-tasks/{id}": {
      get: {
        summary: "Get a human task",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Task" } },
      },
    },
    "/human-tasks/{id}/complete": {
      post: {
        summary: "Complete a human task",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { response: {}, approved: { type: "boolean" } },
              },
            },
          },
        },
        responses: { "200": { description: "Completed task" } },
      },
    },
  },
};
