import { describe, expect, it } from "vitest";
import { CapabilityRegistry, capabilityId } from "./registry.ts";
import { secretRef, sanitizeAuth } from "./auth.ts";
import { isPermanentInteropError, isTransientInteropError } from "./retry.ts";
import { jsonSchemaFromTool, mcpToolDescriptor, normalizeA2AResult, normalizeMcpToolResult } from "./schema.ts";
import {
  A2AAuthError,
  A2AConnectionError,
  McpAuthError,
  McpConnectionError,
  McpUnknownToolError,
  TimeoutError,
} from "../core/errors.ts";
import { tool } from "../sdk/agent.ts";
import { z } from "zod";

describe("capability registry", () => {
  it("registers and resolves capabilities by stable id", () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: "mcp:github:get_pull_request",
      name: "get_pull_request",
      kind: "tool",
      source: "mcp",
      async invoke(input) {
        return { output: input, status: "completed" };
      },
    });
    expect(registry.get("mcp:github:get_pull_request").name).toBe("get_pull_request");
    expect(capabilityId("mcp", "github", "get_pull_request")).toBe("mcp:github:get_pull_request");
    expect(registry.listBySource("mcp")).toHaveLength(1);
  });
});

describe("schema and result translation", () => {
  it("maps tool schemas to MCP descriptors", () => {
    const lookup = tool({
      name: "lookup-customer",
      description: "Find a customer",
      input: z.object({ id: z.string() }),
      execute: async () => ({ id: "1" }),
    });
    expect(mcpToolDescriptor(lookup)).toMatchObject({
      name: "lookup-customer",
      description: "Find a customer",
    });
    expect(jsonSchemaFromTool({ inputSchema: { type: "number" } })).toEqual({ type: "number" });
  });

  it("normalizes MCP and A2A results", () => {
    expect(normalizeMcpToolResult({ content: [{ text: "{\"ok\":true}" }] })).toEqual({ ok: true });
    expect(normalizeMcpToolResult({ structuredContent: { id: 1 } })).toEqual({ id: 1 });
    expect(normalizeA2AResult({ status: "completed", result: { summary: "done" } })).toEqual({ summary: "done" });
    expect(normalizeA2AResult({ status: "completed", artifacts: [{ parts: [{ text: "{\"n\":2}" }] }] })).toEqual({ n: 2 });
  });
});

describe("auth references", () => {
  it("does not persist raw headers", () => {
    expect(secretRef("GITHUB_TOKEN")).toEqual({ kind: "secret-ref", name: "GITHUB_TOKEN" });
    expect(sanitizeAuth({ kind: "headers", headers: { authorization: "Bearer secret" } })).toEqual({
      kind: "secret-ref",
      name: "[headers omitted]",
    });
  });
});

describe("retry classification", () => {
  it("treats transport failures as transient and auth as permanent", () => {
    expect(isTransientInteropError(new McpConnectionError("down"))).toBe(true);
    expect(isTransientInteropError(new A2AConnectionError("down"))).toBe(true);
    expect(isTransientInteropError(new TimeoutError("slow"))).toBe(true);
    expect(isPermanentInteropError(new McpAuthError())).toBe(true);
    expect(isPermanentInteropError(new A2AAuthError())).toBe(true);
    expect(isPermanentInteropError(new McpUnknownToolError("missing"))).toBe(true);
    expect(isTransientInteropError(new McpAuthError())).toBe(false);
  });
});
