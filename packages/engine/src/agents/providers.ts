import { toJson } from "../core/serialize.ts";
import type { Json } from "../core/types.ts";
import type {
  AgentMessage,
  AgentProvider,
  AgentRequest,
  AgentResult,
  AgentToolCall,
} from "../sdk/types.ts";
import type { ModelProvider, ModelRequest, ModelResponse } from "../models/model-types.ts";

interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class OpenAIAgentProvider implements AgentProvider, ModelProvider {
  readonly name = "openai";

  constructor(private readonly options: OpenAIOptions) {}

  async execute(request: AgentRequest): Promise<AgentResult> {
    return agentResultFromModel(
      request,
      await this.generate(modelRequestFromAgent(request, request.abortSignal)),
    );
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = request.model || this.options.model || "gpt-4o-mini";
    const messages = toOpenAIModelMessages(request);
    const tools = (request.tools ?? []).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const response = await fetch(`${trimSlash(this.options.baseUrl ?? "https://api.openai.com/v1")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: 0,
      }),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI provider error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices?.[0];
    const toolCalls: AgentToolCall[] = (choice?.message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: parseArgs(call.function.arguments),
    }));

    const content = choice?.message?.content ?? "";
    let output: unknown = content || null;
    if (content) {
      try {
        output = JSON.parse(content);
      } catch {
        output = content;
      }
    }

    return {
      content: content || undefined,
      output: toolCalls.length > 0 ? null : output,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
      finishReason: choice?.finish_reason,
    };
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function parseArgs(raw: string): Json {
  try {
    return toJson(JSON.parse(raw));
  } catch {
    return { raw };
  }
}

function toOpenAIModelMessages(request: ModelRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content ?? "",
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    return { role: message.role, content: message.content ?? "" };
  });
}

export function modelRequestFromAgent(request: AgentRequest, abortSignal?: AbortSignal): ModelRequest {
  const messages: ModelRequest["messages"] = [{ role: "system", content: request.instructions }];
  if (request.messages.length === 0) {
    messages.push({ role: "user", content: JSON.stringify(request.input) });
  } else {
    messages.push(...request.messages);
  }
  return {
    model: request.model ?? "",
    messages,
    tools: request.tools,
    outputSchema: request.outputSchema,
    abortSignal: abortSignal ?? request.abortSignal,
  };
}

export function agentResultFromModel(request: AgentRequest, response: ModelResponse): AgentResult {
  const assistant: AgentMessage = {
    role: "assistant",
    content: response.content,
    toolCalls: response.toolCalls,
  };
  return {
    output: response.toolCalls?.length ? null : (response.output ?? response.content ?? null),
    messages: [...request.messages, assistant],
    toolCalls: response.toolCalls,
    model: response.model,
    tokenInput: response.usage?.inputTokens,
    tokenOutput: response.usage?.outputTokens,
    finishReason: response.finishReason,
  };
}

export class ScriptedAgentProvider implements AgentProvider {
  readonly name = "scripted";
  private index = 0;

  constructor(private readonly script: AgentResult[]) {}

  async execute(_request: AgentRequest): Promise<AgentResult> {
    const next = this.script[this.index];
    if (!next) {
      throw new Error("Scripted agent has no remaining turns");
    }
    this.index += 1;
    return next;
  }
}

export class ModelBackedAgentProvider implements AgentProvider {
  readonly name: string;

  constructor(
    private readonly resolved: { provider: ModelProvider; model: string },
    private readonly abortSignal?: AbortSignal,
  ) {
    this.name = resolved.provider.name;
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const response = await this.resolved.provider.generate({
      ...modelRequestFromAgent(request, request.abortSignal ?? this.abortSignal),
      model: this.resolved.model || request.model || "",
      outputSchema: request.outputSchema,
    });
    return agentResultFromModel(request, response);
  }
}

export class ScriptedModelProvider implements ModelProvider {
  readonly name: string;
  private index = 0;

  constructor(
    private readonly script: ModelResponse[],
    name = "scripted",
  ) {
    this.name = name;
  }

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    const next = this.script[this.index];
    if (!next) {
      throw new Error("Scripted model has no remaining turns");
    }
    this.index += 1;
    return next;
  }
}
