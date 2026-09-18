import { defineApp, workflow } from "@drassos/engine";
import { refundAgent } from "./agent.ts";
import { issueRefund, loadCustomer } from "./services.ts";

export interface RefundInput {
  customerId: string;
  amount: number;
  reason: string;
  sleepDuration?: string | number;
}

export const customerRefund = workflow<RefundInput, unknown>(
  "customer-refund",
  async (ctx) => {
    const customer = await ctx.step("load-customer", async () => loadCustomer(ctx.input.customerId));

    const analysis = await ctx.agent<{
      summary: string;
      risk: string;
      requiresApproval: boolean;
    }>("analyze-refund", {
      agent: refundAgent,
      input: {
        customer,
        amount: ctx.input.amount,
        reason: ctx.input.reason,
      },
    });

    let approval: unknown = null;
    if (ctx.input.amount > 100) {
      approval = await ctx.human("approve-refund", {
        title: "Approve customer refund",
        assignedTo: "support",
        data: {
          customer,
          amount: ctx.input.amount,
          reason: ctx.input.reason,
          analysis,
        },
      });
    }

    const refund = await ctx.step(
      "issue-refund",
      {
        retry: { maxAttempts: 3, backoff: "exponential", initialIntervalMs: 50 },
        timeout: "30s",
        idempotencyKey: `refund:${ctx.input.customerId}:${ctx.input.amount}:${ctx.input.reason}`,
      },
      async () =>
        issueRefund({
          customerId: ctx.input.customerId,
          amount: ctx.input.amount,
          reason: ctx.input.reason,
          idempotencyKey: `refund:${ctx.input.customerId}:${ctx.input.amount}:${ctx.input.reason}`,
        }),
    );

    await ctx.sleep("wait-confirmation-window", ctx.input.sleepDuration ?? "10s");
    const confirmation = await ctx.waitForEvent("refund.confirmed");

    return {
      customer,
      analysis,
      approval,
      refund,
      confirmation,
    };
  },
);

export default defineApp({
  workflows: [customerRefund],
});
