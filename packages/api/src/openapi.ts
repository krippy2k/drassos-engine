export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Drassos API",
    version: "0.8.0",
    description: "HTTP API for the Drassos durable orchestration engine, including observability and the worker protocol.",
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
    "/runs/{id}/tree": {
      get: {
        summary: "Get the execution tree for a run",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Execution tree" }, "404": { description: "Not found" } },
      },
    },
    "/executions/{id}": {
      get: {
        summary: "Get execution metadata",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Execution" }, "404": { description: "Not found" } },
      },
    },
    "/executions/{id}/tree": {
      get: {
        summary: "Get an execution tree",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Execution tree" }, "404": { description: "Not found" } },
      },
    },
    "/executions/{id}/cancel": {
      post: {
        summary: "Cancel an execution and descendants according to policy",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Cancelled" }, "404": { description: "Not found" } },
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
      get: {
        summary: "List history events for a run",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "after", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "Events" }, "404": { description: "Not found" } },
      },
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
    "/workflows/{workflowId}/signals/{signalName}": {
      post: {
        summary: "Deliver a named signal to a workflow execution",
        parameters: [
          { name: "workflowId", in: "path", required: true, schema: { type: "string" } },
          { name: "signalName", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { id: { type: "string" }, payload: {} },
              },
            },
          },
        },
        responses: {
          "202": { description: "Accepted" },
          "200": { description: "Duplicate signal id" },
          "404": { description: "Run not found" },
          "409": { description: "Run is terminal" },
        },
      },
    },
    "/workflows/{workflowId}/interactions": {
      get: {
        summary: "List human interactions for a workflow execution",
        parameters: [{ name: "workflowId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Interactions" } },
      },
    },
    "/workflows/{workflowId}/interactions/{interactionId}": {
      get: {
        summary: "Get a human interaction",
        parameters: [
          { name: "workflowId", in: "path", required: true, schema: { type: "string" } },
          { name: "interactionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Interaction" }, "404": { description: "Not found" } },
      },
    },
    "/workflows/{workflowId}/interactions/{interactionId}/complete": {
      post: {
        summary: "Complete a human interaction",
        parameters: [
          { name: "workflowId", in: "path", required: true, schema: { type: "string" } },
          { name: "interactionId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["outcome"],
                properties: {
                  outcome: { type: "string", enum: ["approved", "rejected", "changes_requested"] },
                  reason: { type: "string" },
                  feedback: { type: "string" },
                  data: {},
                },
              },
            },
          },
        },
        responses: { "200": { description: "Completed interaction" } },
      },
    },
    "/interactions": {
      get: { summary: "List pending human interactions", responses: { "200": { description: "Pending interactions" } } },
    },
    "/worker/register": {
      post: { summary: "Register a remote worker", responses: { "200": { description: "Registered" }, "401": { description: "Unauthorized" } } },
    },
    "/worker/heartbeat": {
      post: { summary: "Worker process heartbeat", responses: { "200": { description: "OK" } } },
    },
    "/worker/tasks/poll": {
      post: { summary: "Claim leased tasks from named queues", responses: { "200": { description: "Tasks" } } },
    },
    "/worker/tasks/{taskId}/heartbeat": {
      post: { summary: "Extend a task lease", responses: { "200": { description: "OK" }, "409": { description: "Stale lease" } } },
    },
    "/worker/tasks/{taskId}/complete": {
      post: { summary: "Complete a leased task", responses: { "200": { description: "Completed" }, "409": { description: "Stale lease" } } },
    },
    "/worker/tasks/{taskId}/fail": {
      post: { summary: "Fail a leased task", responses: { "200": { description: "Failed or retrying" }, "409": { description: "Stale lease" } } },
    },
    "/metrics/queues": {
      get: { summary: "Queue depth and completion metrics", responses: { "200": { description: "Queue metrics" } } },
    },
    "/workers": {
      get: { summary: "Registered workers", responses: { "200": { description: "Worker list" } } },
    },
    "/runs/{id}/trace": {
      get: {
        summary: "Get the observability trace tree",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Trace" }, "404": { description: "Not found" } },
      },
    },
    "/runs/{id}/graph": {
      get: {
        summary: "Get the execution graph",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Graph" }, "404": { description: "Not found" } },
      },
    },
    "/runs/{id}/logs": {
      get: {
        summary: "Get run-correlated logs",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Logs" }, "404": { description: "Not found" } },
      },
    },
    "/runs/{id}/snapshot": {
      get: {
        summary: "Inspect historical state at a history seq",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "seq", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "Snapshot" }, "404": { description: "Not found" } },
      },
    },
    "/runs/{id}/fork": {
      post: {
        summary: "Fork a new run from a historical seq",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "201": { description: "Forked run" }, "404": { description: "Not found" } },
      },
    },
    "/runs/{id}/stream": {
      get: {
        summary: "Subscribe to live run history via SSE",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Event stream" } },
      },
    },
    "/metrics/overview": {
      get: { summary: "Aggregate observability metrics", responses: { "200": { description: "Metrics" } } },
    },
  },
};
