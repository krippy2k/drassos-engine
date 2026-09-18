import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { McpConnectionError, McpProtocolError } from "../core/errors.ts";
import type { Json } from "../core/types.ts";
import type { ToolDefinition } from "../sdk/types.ts";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Json;
}

export interface McpClient {
  readonly name: string;
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export type McpServerConfig =
  | { kind: "stdio"; name?: string; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: "http"; name?: string; url: string; headers?: Record<string, string> }
  | { kind: "memory"; name: string; tools: Array<{ name: string; description: string; inputSchema?: Json; execute: (input: unknown) => unknown | Promise<unknown> }> };

export class McpServerResource {
  readonly kind = "mcp-resource" as const;
  readonly name: string;
  constructor(public readonly config: McpServerConfig) {
    this.name =
      config.kind === "stdio"
        ? config.name ?? config.command
        : config.kind === "http"
          ? config.name ?? config.url
          : config.name;
  }
}

export const mcp = {
  server(options: { name?: string; command: string; args?: string[]; env?: Record<string, string> }): McpServerResource {
    return new McpServerResource({ kind: "stdio", ...options });
  },
  http(options: { name?: string; url: string; headers?: Record<string, string> }): McpServerResource {
    return new McpServerResource({ kind: "http", ...options });
  },
  memory(
    name: string,
    tools: Array<{
      name: string;
      description: string;
      inputSchema?: Json;
      execute: (input: unknown) => unknown | Promise<unknown>;
    }>,
  ): McpServerResource {
    return new McpServerResource({ kind: "memory", name, tools });
  },
};

export class McpManager {
  private readonly clients = new Map<string, McpClient>();

  async clientFor(resource: McpServerResource): Promise<McpClient> {
    const existing = this.clients.get(resource.name);
    if (existing) {
      return existing;
    }
    const client = createMcpClient(resource.config);
    await client.connect();
    this.clients.set(resource.name, client);
    return client;
  }

  async toolsFor(resource: McpServerResource): Promise<ToolDefinition[]> {
    const client = await this.clientFor(resource);
    const discovered = await client.listTools();
    return discovered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      source: "mcp" as const,
      server: resource.name,
      execute: async (input: unknown) => {
        try {
          const active = await this.clientFor(resource);
          return await active.callTool(tool.name, input);
        } catch (error) {
          if (error instanceof McpConnectionError) {
            const retried = await this.reconnect(resource);
            return retried.callTool(tool.name, input);
          }
          throw error;
        }
      },
    }));
  }

  async reconnect(resource: McpServerResource): Promise<McpClient> {
    const existing = this.clients.get(resource.name);
    if (existing) {
      await existing.close().catch(() => undefined);
      this.clients.delete(resource.name);
    }
    return this.clientFor(resource);
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }
}

function createMcpClient(config: McpServerConfig): McpClient {
  if (config.kind === "memory") {
    return new MemoryMcpClient(config.name, config.tools);
  }
  if (config.kind === "http") {
    return new HttpMcpClient(config.name ?? config.url, config.url, config.headers ?? {});
  }
  return new StdioMcpClient(config.name ?? config.command, config.command, config.args ?? [], config.env ?? {});
}

class MemoryMcpClient implements McpClient {
  constructor(
    readonly name: string,
    private readonly tools: Array<{
      name: string;
      description: string;
      inputSchema?: Json;
      execute: (input: unknown) => unknown | Promise<unknown>;
    }>,
  ) {}

  async connect(): Promise<void> {}

  async listTools(): Promise<McpToolInfo[]> {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new McpProtocolError(`Unknown MCP tool: ${name}`);
    }
    return tool.execute(args);
  }

  async close(): Promise<void> {}
}

class HttpMcpClient implements McpClient {
  private nextId = 1;
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "drassos", version: "0.2.0" },
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpToolInfo[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    if (result.isError) {
      throw new McpProtocolError(result.content?.[0]?.text ?? `MCP tool ${name} failed`);
    }
    const text = result.content?.map((part) => part.text ?? "").join("\n") ?? JSON.stringify(result);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async close(): Promise<void> {}

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    } catch (error) {
      throw new McpConnectionError(`MCP HTTP server unavailable: ${this.url}`, error);
    }
    if (!response.ok) {
      throw new McpConnectionError(`MCP HTTP error ${response.status}`);
    }
    const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (payload.error) {
      throw new McpProtocolError(payload.error.message ?? "MCP protocol error");
    }
    return payload.result;
  }
}

class StdioMcpClient implements McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    try {
      this.child = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new McpConnectionError(`Failed to start MCP server ${this.command}`, error);
    }
    this.child.on("exit", () => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new McpConnectionError(`MCP server ${this.name} terminated`));
      }
      this.pending.clear();
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "drassos", version: "0.2.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpToolInfo[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    if (result.isError) {
      throw new McpProtocolError(result.content?.[0]?.text ?? `MCP tool ${name} failed`);
    }
    const text = result.content?.map((part) => part.text ?? "").join("\n") ?? JSON.stringify(result);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async close(): Promise<void> {
    this.child?.kill();
    this.child = undefined;
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpConnectionError(`MCP RPC timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(new McpConnectionError(`Failed to write to MCP server`, error));
      }
    });
  }

  private send(message: unknown): void {
    if (!this.child?.stdin.writable) {
      throw new McpConnectionError(`MCP server ${this.name} is not running`);
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        const line = this.buffer.toString("utf8");
        if (line.includes("\n") && line.trim().startsWith("{")) {
          const first = line.split("\n")[0] ?? "";
          this.consumeMessage(first);
          this.buffer = Buffer.from(line.slice(first.length + 1));
          continue;
        }
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) {
        return;
      }
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      this.consumeMessage(body);
    }
  }

  private consumeMessage(body: string): void {
    let payload: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      payload = JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } };
    } catch {
      return;
    }
    if (payload.id === undefined) {
      return;
    }
    const waiter = this.pending.get(payload.id);
    if (!waiter) {
      return;
    }
    this.pending.delete(payload.id);
    if (payload.error) {
      waiter.reject(new McpProtocolError(payload.error.message ?? "MCP protocol error"));
      return;
    }
    waiter.resolve(payload.result);
  }
}
