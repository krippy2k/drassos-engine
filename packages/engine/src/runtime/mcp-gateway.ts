import { randomUUID } from "node:crypto";
import {
  McpAuthError,
  McpProtocolError,
  McpUnknownToolError,
} from "../core/errors.ts";
import type { ToolDefinition, WorkflowDefinition } from "../sdk/types.ts";
import { executeAuthorizedTool } from "../tools/tool-executor.ts";
import { mcpToolDescriptor } from "../capabilities/schema.ts";
import { capabilityId } from "../capabilities/registry.ts";
import { listenJsonRpc, type HttpRpcServer } from "./http-rpc.ts";
import type { Drassos } from "./create-drassos.ts";

export interface McpExposedTool {
  name: string;
  tool?: ToolDefinition;
  workflow?: WorkflowDefinition;
}

export interface McpGatewayHandle {
  tool(name: string, spec: { tool?: ToolDefinition; workflow?: WorkflowDefinition }): void;
  bind(drassos: Drassos): void;
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
  url?: string;
}

export function createMcpServer(options: {
  name: string;
  drassos?: Drassos;
  auth?: (headers: Record<string, string>) => Promise<void> | void;
  waitTimeoutMs?: number;
}): McpGatewayHandle {
  const exposed = new Map<string, McpExposedTool>();
  let drassos = options.drassos;
  let server: HttpRpcServer | undefined;

  const handle: McpGatewayHandle = {
    tool(name, spec) {
      if (!spec.tool && !spec.workflow) {
        throw new Error(`MCP tool "${name}" requires tool or workflow`);
      }
      exposed.set(name, { name, tool: spec.tool, workflow: spec.workflow });
    },
    bind(instance) {
      drassos = instance;
    },
    async listen(port = 0) {
      server = await listenJsonRpc({
        port,
        onRpc: async ({ method, params, headers }) => {
          if (options.auth) {
            try {
              await options.auth(headers);
            } catch (error) {
              throw Object.assign(error instanceof Error ? error : new McpAuthError(), {
                httpStatus: 401,
                rpcCode: -32001,
              });
            }
          }
          if (method === "initialize") {
            return {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: options.name, version: "0.6.0" },
            };
          }
          if (method === "notifications/initialized") {
            return {};
          }
          if (method === "tools/list") {
            return {
              tools: [...exposed.values()].map((item) =>
                mcpToolDescriptor(
                  item.tool ?? {
                    name: item.name,
                    description: item.workflow?.name ?? item.name,
                    execute: async () => null,
                  },
                ),
              ),
            };
          }
          if (method === "tools/call") {
            const record = isRecord(params) ? params : {};
            const name = String(record.name ?? "");
            const args = record.arguments ?? record.input ?? {};
            const clientRequestId =
              typeof record.clientRequestId === "string" ? record.clientRequestId : randomUUID();
            return callExposed(name, args, clientRequestId);
          }
          throw Object.assign(new McpProtocolError(`Unknown method ${method}`), { rpcCode: -32601 });
        },
      });
      handle.url = server.url;
      return { url: server.url, port: server.port };
    },
    async close() {
      await server?.close();
    },
  };

  async function callExposed(name: string, args: unknown, clientRequestId: string): Promise<unknown> {
    const spec = exposed.get(name);
    if (!spec) {
      throw Object.assign(new McpUnknownToolError(name), { rpcCode: -32601 });
    }
    if (spec.tool) {
      try {
        const output = await executeAuthorizedTool(spec.tool, args, {
          runId: "mcp",
          workflowId: "mcp",
          agentExecutionId: "mcp",
          toolCallId: clientRequestId,
          idempotencyKey: clientRequestId,
          abortSignal: new AbortController().signal,
        });
        return mcpContent(output);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }
    if (!spec.workflow) {
      throw new McpUnknownToolError(name);
    }
    if (!drassos) {
      throw new McpProtocolError("MCP server is not bound to a Drassos runtime");
    }
    if (!drassos.registry.has(spec.workflow.name)) {
      drassos.registry.register(spec.workflow);
    }
    const existing = await drassos.store.findRemoteOperationByClientRequest(clientRequestId);
    const run = existing
      ? await drassos.store.getRun(existing.runId)
      : await drassos.executor.startRun(spec.workflow.name, args, undefined, { enqueue: false });
    if (!run) {
      throw new McpProtocolError("Failed to start workflow-backed MCP tool");
    }
    if (!existing) {
      await drassos.store.insertRemoteOperation({
        runId: run.id,
        capabilityId: capabilityId("mcp", options.name, name),
        provider: "mcp-inbound",
        endpointRef: options.name,
        remoteTaskId: run.id,
        clientRequestId,
        status: "WORKING",
        correlation: { tool: name, workflow: spec.workflow.name },
      });
      await drassos.executor.executeRun(run.id);
    }
    const finished = await drassos.store.getRun(run.id);
    if (finished?.status === "COMPLETED") {
      const op = existing ?? (await drassos.store.findRemoteOperationByClientRequest(clientRequestId));
      if (op) {
        await drassos.store.updateRemoteOperation(op.id, {
          status: "COMPLETED",
          result: (finished.output as never) ?? null,
          completedAt: new Date().toISOString(),
        });
      }
      return mcpContent({ status: "completed", output: finished.output, runId: run.id });
    }
    if (finished?.status === "FAILED") {
      return {
        isError: true,
        content: [{ type: "text", text: finished.error?.message ?? "workflow failed" }],
      };
    }
    return mcpContent({ status: "working", runId: run.id });
  }

  return handle;
}

function mcpContent(output: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
