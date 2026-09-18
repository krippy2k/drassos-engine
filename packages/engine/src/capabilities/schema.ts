import type { Json } from "../core/types.ts";
import type { ToolDefinition } from "../sdk/types.ts";

export function jsonSchemaFromTool(tool: Pick<ToolDefinition, "input" | "inputSchema">): Json {
  if (tool.inputSchema) {
    return tool.inputSchema;
  }
  return { type: "object", additionalProperties: true };
}

export function mcpToolDescriptor(tool: ToolDefinition): {
  name: string;
  description: string;
  inputSchema: Json;
} {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchemaFromTool(tool),
  };
}

export function normalizeMcpToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const payload = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  if (payload.structuredContent !== undefined) {
    return payload.structuredContent;
  }
  if (!payload.content) {
    return result;
  }
  const text = payload.content.map((part) => part.text ?? "").join("\n");
  if (!text) {
    return result;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function normalizeA2AResult(task: {
  status: string;
  result?: unknown;
  artifacts?: Array<{ parts?: Array<{ text?: string }> }>;
}): unknown {
  if (task.result !== undefined) {
    return task.result;
  }
  const text = task.artifacts
    ?.flatMap((artifact) => artifact.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
