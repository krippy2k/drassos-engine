import type { Json } from "./types.ts";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Json;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Json;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  outputSchema?: unknown;
  abortSignal?: AbortSignal;
}

export interface ModelResponse {
  content?: string;
  output?: unknown;
  toolCalls?: ModelToolCall[];
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
  metadata?: Json;
}

export interface ModelProvider {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export interface ResolvedModel {
  provider: ModelProvider;
  model: string;
}

export function parseModelRef(ref: string): { provider?: string; model: string } {
  const index = ref.indexOf(":");
  if (index <= 0) {
    return { model: ref };
  }
  return { provider: ref.slice(0, index), model: ref.slice(index + 1) };
}
