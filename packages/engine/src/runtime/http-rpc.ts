import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: unknown;
}

export interface HttpRpcServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function listenJsonRpc(options: {
  port?: number;
  host?: string;
  onRpc: (request: {
    method: string;
    params: unknown;
    headers: Record<string, string>;
    id: unknown;
  }) => Promise<unknown>;
  onGet?: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<{ status: number; body: unknown } | null> | { status: number; body: unknown } | null;
}): Promise<HttpRpcServer> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void handleHttp(req, res, options);
  });
  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind JSON-RPC server");
  }
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    close: async () => {
      server.close();
      await once(server, "close").catch(() => undefined);
    },
  };
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: Parameters<typeof listenJsonRpc>[0],
): Promise<void> {
  const headers = flattenHeaders(req.headers);
  const url = req.url ?? "/";
  try {
    if (req.method === "GET" && options.onGet) {
      const result = await options.onGet(url, headers);
      if (result) {
        writeJson(res, result.status, result.body);
        return;
      }
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    const body = await readBody(req);
    let payload: JsonRpcRequest;
    try {
      payload = JSON.parse(body) as JsonRpcRequest;
    } catch {
      writeJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      return;
    }
    if (!payload.method) {
      writeJson(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: payload.id ?? null });
      return;
    }
    try {
      const result = await options.onRpc({
        method: payload.method,
        params: payload.params ?? {},
        headers,
        id: payload.id,
      });
      if (payload.id === undefined) {
        res.statusCode = 204;
        res.end();
        return;
      }
      writeJson(res, 200, { jsonrpc: "2.0", id: payload.id, result });
    } catch (error) {
      const status = (error as { httpStatus?: number }).httpStatus ?? 200;
      writeJson(res, status, {
        jsonrpc: "2.0",
        id: payload.id ?? null,
        error: {
          code: (error as { rpcCode?: number }).rpcCode ?? -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  } catch (error) {
    writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      result[key.toLowerCase()] = value.join(",");
    }
  }
  return result;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}
