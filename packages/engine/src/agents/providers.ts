import { toJson } from "../core/serialize.ts";
import type { Json } from "../core/types.ts";
import type {
  AgentMessage,
  AgentProvider,
  AgentRequest,
  AgentResult,
  AgentToolCall,
} from "../sdk/types.ts";

interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class OpenAIAgentProvider implements AgentProvider {
  readonly name = "openai";

  constructor(private readonly options: OpenAIOptions) {}

  async execute(request: AgentRequest): Promise<AgentResult> {
    const model = request.model ?? this.options.model ?? "gpt-4o-mini";
    const messages = toOpenAIMessages(request);
    const tools = request.tools.map((tool) => ({
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
    let output: unknown = content;
    if (content) {
      try {
        output = JSON.parse(content);
      } catch {
        output = content;
      }
    }

    const assistant: AgentMessage = {
      role: "assistant",
      content: content || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    return {
      output: toolCalls.length > 0 ? null : output,
      messages: [...request.messages, assistant],
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      tokenInput: data.usage?.prompt_tokens,
      tokenOutput: data.usage?.completion_tokens,
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

function toOpenAIMessages(request: AgentRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: request.instructions },
  ];
  if (request.messages.length === 0) {
    messages.push({ role: "user", content: JSON.stringify(request.input) });
    return messages;
  }
  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content ?? "",
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });
      continue;
    }
    messages.push({ role: message.role, content: message.content ?? "" });
  }
  return messages;
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
