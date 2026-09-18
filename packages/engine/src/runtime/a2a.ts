import { randomUUID } from "node:crypto";
import {
  A2AAuthError,
  A2AConnectionError,
  A2AProtocolError,
  A2ARemoteError,
} from "../core/errors.ts";
import type { AuthRef } from "../capabilities/types.ts";
import { envAuthProvider, type AuthProvider } from "../capabilities/auth.ts";
import { capabilityId } from "../capabilities/registry.ts";
import type { Capability, CapabilityResult } from "../capabilities/types.ts";
import { normalizeA2AResult } from "../capabilities/schema.ts";
import type { AgentDefinition } from "../sdk/types.ts";
import { isTerminalStatus } from "../core/status.ts";
import { listenJsonRpc, type HttpRpcServer } from "./http-rpc.ts";
import type { Drassos } from "./create-drassos.ts";

export interface AgentCard {
  name: string;
  description?: string;
  url?: string;
  protocolVersion: string;
  skills: Array<{ id: string; name: string; description?: string }>;
  authentication?: { schemes?: string[] };
}

export interface A2ATask {
  id: string;
  status: "submitted" | "working" | "completed" | "failed" | "canceled" | "cancelled";
  result?: unknown;
  error?: string;
  clientRequestId?: string;
}

export interface RemoteAgent {
  kind: "a2a";
  name: string;
  url?: string;
  description?: string;
  auth?: AuthRef;
  timeout?: string | number;
  service?: InMemoryA2AService;
  capability: Capability;
  discover(): Promise<AgentCard>;
}

export interface A2AAgentOptions {
  name: string;
  url?: string | (() => string);
  description?: string;
  auth?: AuthRef;
  timeout?: string | number;
  service?: InMemoryA2AService;
}

export function isRemoteAgent(value: unknown): value is RemoteAgent {
  return Boolean(value) && typeof value === "object" && (value as { kind?: string }).kind === "a2a";
}

export class InMemoryA2AService {
  readonly tasks = new Map<string, A2ATask>();
  readonly byRequest = new Map<string, string>();
  sendCount = 0;
  cancelCount = 0;

  constructor(
    private readonly options: {
      name: string;
      description?: string;
      delayMs?: number;
      fail?: boolean;
      handler?: (input: unknown) => unknown | Promise<unknown>;
    },
  ) {}

  card(url = ""): AgentCard {
    return {
      name: this.options.name,
      description: this.options.description ?? this.options.name,
      url,
      protocolVersion: "0.2",
      skills: [{ id: "default", name: "default", description: this.options.description }],
    };
  }

  async send(input: unknown, clientRequestId?: string): Promise<A2ATask> {
    if (clientRequestId && this.byRequest.has(clientRequestId)) {
      return this.tasks.get(this.byRequest.get(clientRequestId)!)!;
    }
    this.sendCount += 1;
    const id = randomUUID();
    const task: A2ATask = { id, status: "working", clientRequestId };
    this.tasks.set(id, task);
    if (clientRequestId) {
      this.byRequest.set(clientRequestId, id);
    }
    void this.complete(task, input);
    return task;
  }

  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }

  cancel(id: string): A2ATask {
    const task = this.tasks.get(id);
    if (!task) {
      throw Object.assign(new A2ARemoteError(`Unknown A2A task ${id}`), { rpcCode: -32001 });
    }
    if (task.status === "working" || task.status === "submitted") {
      task.status = "canceled";
      this.cancelCount += 1;
    }
    return task;
  }

  private async complete(task: A2ATask, input: unknown): Promise<void> {
    try {
      if (this.options.delayMs) {
        await sleep(this.options.delayMs);
      }
      if (task.status === "canceled" || task.status === "cancelled") {
        return;
      }
      if (this.options.fail) {
        task.status = "failed";
        task.error = "remote agent failed";
        return;
      }
      task.result = this.options.handler ? await this.options.handler(input) : input;
      task.status = "completed";
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
    }
  }
}

export function a2aAgent(options: A2AAgentOptions, authProvider: AuthProvider = envAuthProvider): RemoteAgent {
  const capability = a2aAgentCapability(options, authProvider);
  return {
    kind: "a2a",
    name: options.name,
    url: typeof options.url === "function" ? undefined : options.url,
    description: options.description,
    auth: options.auth,
    timeout: options.timeout,
    service: options.service,
    capability,
    async discover() {
      if (options.service) {
        return options.service.card(typeof options.url === "function" ? options.url() : options.url);
      }
      const url = resolveUrl(options.url);
      return fetchAgentCard(url, await authHeaders(options.auth, authProvider));
    },
  };
}

export function a2aAgentCapability(options: A2AAgentOptions, authProvider: AuthProvider = envAuthProvider): Capability {
  return {
    id: capabilityId("a2a", options.name, options.name),
    name: options.name,
    description: options.description,
    kind: "agent",
    source: "a2a",
    provider: options.name,
    timeout: options.timeout,
    auth: options.auth,
    endpoint: typeof options.url === "string" ? options.url : undefined,
    async invoke(input, context): Promise<CapabilityResult> {
      const headers = await authHeaders(options.auth, authProvider);
      if (options.service) {
        const task = await options.service.send(input, context.clientRequestId);
        return taskToResult(task);
      }
      const url = resolveUrl(options.url);
      const task = await a2aRpc<A2ATask>(url, "message/send", {
        message: input,
        clientRequestId: context.clientRequestId,
      }, headers, context.abortSignal);
      return taskToResult(task);
    },
    async recover(context, remoteTaskId): Promise<CapabilityResult> {
      if (options.service) {
        const task = options.service.get(remoteTaskId);
        if (!task) {
          throw new A2ARemoteError(`Unknown A2A task ${remoteTaskId}`);
        }
        return taskToResult(task);
      }
      const headers = await authHeaders(options.auth, authProvider);
      const url = resolveUrl(options.url);
      const task = await a2aRpc<A2ATask>(url, "tasks/get", { id: remoteTaskId }, headers, context.abortSignal);
      return taskToResult(task);
    },
    async cancel(context, remoteTaskId): Promise<void> {
      if (options.service) {
        options.service.cancel(remoteTaskId);
        return;
      }
      const headers = await authHeaders(options.auth, authProvider);
      const url = resolveUrl(options.url);
      await a2aRpc(url, "tasks/cancel", { id: remoteTaskId }, headers, context.abortSignal);
    },
  };
}

function taskToResult(task: A2ATask): CapabilityResult {
  const status =
    task.status === "completed"
      ? "completed"
      : task.status === "failed"
        ? "failed"
        : task.status === "canceled" || task.status === "cancelled"
          ? "cancelled"
          : "working";
  if (status === "failed") {
    throw new A2ARemoteError(task.error ?? `A2A task ${task.id} failed`);
  }
  return {
    output: status === "completed" ? normalizeA2AResult(task) : undefined,
    remoteTaskId: task.id,
    status,
  };
}

async function fetchAgentCard(url: string, headers: Record<string, string>): Promise<AgentCard> {
  const bases = [url.replace(/\/$/, "")];
  const paths = ["/.well-known/agent-card.json", "/agent.json"];
  let lastError: unknown;
  for (const base of bases) {
    for (const path of paths) {
      try {
        const response = await fetch(`${base}${path}`, { headers });
        if (response.status === 401 || response.status === 403) {
          throw new A2AAuthError(`A2A agent card HTTP ${response.status}`);
        }
        if (!response.ok) {
          lastError = new A2AConnectionError(`A2A agent card HTTP ${response.status}`);
          continue;
        }
        return (await response.json()) as AgentCard;
      } catch (error) {
        if (error instanceof A2AAuthError) {
          throw error;
        }
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new A2AConnectionError(`Unable to discover A2A agent at ${url}`, lastError);
}

async function a2aRpc<T = unknown>(
  url: string,
  method: string,
  params: unknown,
  headers: Record<string, string>,
  abortSignal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: abortSignal,
    });
  } catch (error) {
    throw new A2AConnectionError(`A2A server unavailable: ${url}`, error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new A2AAuthError(`A2A HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new A2AConnectionError(`A2A HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) {
    throw new A2AProtocolError(payload.error.message ?? "A2A protocol error");
  }
  return payload.result as T;
}

async function authHeaders(auth: AuthRef | undefined, provider: AuthProvider): Promise<Record<string, string>> {
  if (!auth) {
    return {};
  }
  return provider.resolve(auth);
}

function resolveUrl(url: string | (() => string) | undefined): string {
  if (!url) {
    throw new A2AProtocolError("A2A agent is missing a url");
  }
  return typeof url === "function" ? url() : url;
}

export async function listenA2AService(
  service: InMemoryA2AService,
  options: {
    port?: number;
    auth?: (headers: Record<string, string>) => Promise<void> | void;
  } = {},
): Promise<HttpRpcServer & { service: InMemoryA2AService }> {
  const server = await listenJsonRpc({
    port: options.port,
    onGet: (url) => {
      if (url.includes("agent-card") || url.endsWith("/agent.json") || url.includes("well-known")) {
        return { status: 200, body: service.card() };
      }
      return null;
    },
    onRpc: async ({ method, params, headers }) => {
      await options.auth?.(headers);
      const record = isRecord(params) ? params : {};
      if (method === "message/send") {
        return service.send(record.message ?? record, typeof record.clientRequestId === "string" ? record.clientRequestId : undefined);
      }
      if (method === "tasks/get") {
        const task = service.get(String(record.id ?? ""));
        if (!task) {
          throw Object.assign(new A2ARemoteError("Unknown task"), { rpcCode: -32001 });
        }
        return task;
      }
      if (method === "tasks/cancel") {
        return service.cancel(String(record.id ?? ""));
      }
      throw Object.assign(new A2AProtocolError(`Unknown method ${method}`), { rpcCode: -32601 });
    },
  });
  return { ...server, service };
}

export interface A2AServerHandle {
  agent(definition: AgentDefinition): void;
  bind(drassos: Drassos): void;
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
  url?: string;
}

export function createA2AServer(options: {
  name: string;
  drassos?: Drassos;
  auth?: (headers: Record<string, string>) => Promise<void> | void;
}): A2AServerHandle {
  const agents = new Map<string, AgentDefinition>();
  let drassos = options.drassos;
  let server: HttpRpcServer | undefined;
  const inbound = new Map<string, { task: A2ATask; runId?: string }>();

  const handle: A2AServerHandle = {
    agent(definition) {
      agents.set(definition.name, definition);
    },
    bind(instance) {
      drassos = instance;
    },
    async listen(port = 0) {
      server = await listenJsonRpc({
        port,
        onGet: (urlPath) => {
          if (urlPath.includes("agent-card") || urlPath.endsWith("/agent.json") || urlPath.includes("well-known")) {
            return {
              status: 200,
              body: {
                name: options.name,
                description: "Drassos A2A gateway",
                protocolVersion: "0.2",
                skills: [...agents.values()].map((agent) => ({
                  id: agent.name,
                  name: agent.name,
                  description: agent.instructions,
                })),
                url: server?.url,
              } satisfies AgentCard,
            };
          }
          return null;
        },
        onRpc: async ({ method, params, headers }) => {
          await options.auth?.(headers);
          if (!drassos) {
            throw new A2AProtocolError("A2A gateway is not bound to a Drassos runtime");
          }
          const record = isRecord(params) ? params : {};
          if (method === "message/send") {
            return submitInbound(drassos, agents, inbound, record, options.name);
          }
          if (method === "tasks/get") {
            return getInbound(drassos, inbound, String(record.id ?? ""));
          }
          if (method === "tasks/cancel") {
            return cancelInbound(drassos, inbound, String(record.id ?? ""));
          }
          throw Object.assign(new A2AProtocolError(`Unknown method ${method}`), { rpcCode: -32601 });
        },
      });
      handle.url = server.url;
      return { url: server.url, port: server.port };
    },
    async close() {
      await server?.close();
    },
  };
  return handle;
}

async function submitInbound(
  drassos: Drassos,
  agents: Map<string, AgentDefinition>,
  inbound: Map<string, { task: A2ATask; runId?: string }>,
  params: Record<string, unknown>,
  gatewayName: string,
): Promise<A2ATask> {
  const clientRequestId = typeof params.clientRequestId === "string" ? params.clientRequestId : randomUUID();
  const existingOp = await drassos.store.findRemoteOperationByClientRequest(clientRequestId);
  if (existingOp?.remoteTaskId) {
    const cached = inbound.get(existingOp.remoteTaskId);
    if (cached) {
      return refreshInboundTask(drassos, cached);
    }
  }
  const agentName =
    (typeof params.agent === "string" && params.agent) ||
    (agents.size === 1 ? [...agents.keys()][0] : undefined);
  if (!agentName || !agents.has(agentName)) {
    throw Object.assign(new A2AProtocolError("Unknown agent"), { rpcCode: -32602 });
  }
  const agent = agents.get(agentName)!;
  ensureGatewayWorkflow(drassos, agent);
  const run = await drassos.executor.startRun(gatewayWorkflowName(agent.name), {
    message: params.message ?? params,
    agent: agent.name,
  });
  const task: A2ATask = { id: randomUUID(), status: "working", clientRequestId };
  inbound.set(task.id, { task, runId: run.id });
  await drassos.store.insertRemoteOperation({
    runId: run.id,
    capabilityId: capabilityId("a2a", gatewayName, agent.name),
    provider: "a2a-inbound",
    endpointRef: gatewayName,
    remoteTaskId: task.id,
    clientRequestId,
    status: "WORKING",
    correlation: { agent: agent.name, gateway: gatewayName },
  });
  return refreshInboundTask(drassos, { task, runId: run.id });
}

async function getInbound(
  drassos: Drassos,
  inbound: Map<string, { task: A2ATask; runId?: string }>,
  id: string,
): Promise<A2ATask> {
  const cached = inbound.get(id) ?? (await loadInbound(drassos, id, inbound));
  if (!cached) {
    throw Object.assign(new A2ARemoteError("Unknown task"), { rpcCode: -32001 });
  }
  return refreshInboundTask(drassos, cached);
}

async function cancelInbound(
  drassos: Drassos,
  inbound: Map<string, { task: A2ATask; runId?: string }>,
  id: string,
): Promise<A2ATask> {
  const cached = inbound.get(id) ?? (await loadInbound(drassos, id, inbound));
  if (!cached?.runId) {
    throw Object.assign(new A2ARemoteError("Unknown task"), { rpcCode: -32001 });
  }
  await drassos.cancelExecution(cached.runId, "a2a-cancel");
  cached.task.status = "canceled";
  return cached.task;
}

async function loadInbound(
  drassos: Drassos,
  remoteTaskId: string,
  inbound: Map<string, { task: A2ATask; runId?: string }>,
): Promise<{ task: A2ATask; runId?: string } | null> {
  const op = await drassos.store.getRemoteOperationByRemoteTask("a2a-inbound", remoteTaskId);
  if (!op) {
    return null;
  }
  const entry = {
    task: { id: remoteTaskId, status: "working" as const, clientRequestId: op.clientRequestId },
    runId: op.runId,
  };
  inbound.set(remoteTaskId, entry);
  return entry;
}

async function refreshInboundTask(
  drassos: Drassos,
  entry: { task: A2ATask; runId?: string },
): Promise<A2ATask> {
  if (!entry.runId) {
    return entry.task;
  }
  const run = await drassos.store.getRun(entry.runId);
  if (!run) {
    return entry.task;
  }
  if (run.status === "COMPLETED") {
    entry.task.status = "completed";
    entry.task.result = run.output;
  } else if (run.status === "FAILED") {
    entry.task.status = "failed";
    entry.task.error = run.error?.message;
  } else if (run.status === "CANCELLED") {
    entry.task.status = "canceled";
  } else if (isTerminalStatus(run.status)) {
    entry.task.status = "failed";
  } else {
    entry.task.status = "working";
  }
  return entry.task;
}

function gatewayWorkflowName(agentName: string): string {
  return `a2a-gateway:${agentName}`;
}

function ensureGatewayWorkflow(drassos: Drassos, agent: AgentDefinition): void {
  const name = gatewayWorkflowName(agent.name);
  if (drassos.registry.has(name)) {
    return;
  }
  drassos.registry.register({
    name,
    version: "1",
    fn: async (ctx) => {
      const input = ctx.input as { message?: unknown };
      return ctx.agent.run(agent, { input: input.message ?? ctx.input });
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
