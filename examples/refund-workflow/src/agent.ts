import { defineAgent, tool, type AgentRequest, type AgentResult, type AgentProvider } from "@drassos/engine";
import { z } from "zod";
import { lookupOrders, lookupRefundHistory } from "./services.ts";

export const lookupOrdersTool = tool({
  name: "lookupOrders",
  description: "Look up recent orders for a customer",
  input: z.object({ customerId: z.string() }),
  execute: async ({ customerId }) => lookupOrders(customerId),
});

export const lookupRefundHistoryTool = tool({
  name: "lookupRefundHistory",
  description: "Look up previous refunds for a customer",
  input: z.object({ customerId: z.string() }),
  execute: async ({ customerId }) => lookupRefundHistory(customerId),
});

export class LocalRefundAgentProvider implements AgentProvider {
  readonly name = "local-refund";

  async execute(request: AgentRequest): Promise<AgentResult> {
    const toolNames = new Set(request.tools.map((tool) => tool.name));
    const completed = new Set(
      request.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
    );
    const needed: Array<{ id: string; name: string; arguments: { customerId: string } }> = [];
    const input = request.input as { customer?: { id?: string }; customerId?: string; amount?: number };
    const customerId = input.customer?.id ?? input.customerId ?? "unknown";

    if (toolNames.has("lookupOrders") && !completed.has("call_orders")) {
      needed.push({ id: "call_orders", name: "lookupOrders", arguments: { customerId } });
    }
    if (toolNames.has("lookupRefundHistory") && !completed.has("call_history")) {
      needed.push({ id: "call_history", name: "lookupRefundHistory", arguments: { customerId } });
    }
    if (needed.length > 0) {
      return {
        output: null,
        toolCalls: needed,
        model: "local-refund-v1",
        tokenInput: 32,
        tokenOutput: 12,
      };
    }

    const amount = Number(input.amount ?? 0);
    const output = {
      summary:
        amount > 100
          ? "High-value refund. Review order history and prior refunds before issuing."
          : "Standard refund. History looks consistent with a routine return.",
      risk: amount > 100 ? "medium" : "low",
      requiresApproval: amount > 100,
    };
    return {
      output,
      model: "local-refund-v1",
      tokenInput: 96,
      tokenOutput: 48,
    };
  }
}

export const refundAgent = defineAgent({
  name: "refund-analyst",
  instructions:
    "Analyze a customer refund request. Use tools to inspect orders and prior refunds, then return JSON with summary, risk, and requiresApproval.",
  tools: [lookupOrdersTool, lookupRefundHistoryTool],
  provider: new LocalRefundAgentProvider(),
});
