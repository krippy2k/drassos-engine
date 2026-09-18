import { defineApp, workflow } from "@drassos/engine";

export const sideEffects = {
  charges: 0,
  chargesV2: 0,
};

export function resetSideEffects(): void {
  sideEffects.charges = 0;
  sideEffects.chargesV2 = 0;
}

export interface OrderInput {
  orderId: string;
  amount: number;
}

export const orderProcessingV1 = workflow<OrderInput, { version: string; charged: { ok: boolean; amount: number }; stamped: string }>(
  "order-processing",
  {
    version: "1.0.0",
    run: async (ctx) => {
      const charged = await ctx.step("charge", async () => {
        sideEffects.charges += 1;
        return { ok: true, amount: ctx.input.amount };
      });
      const stamped = ctx.now();
      await ctx.human("review", { title: `Review charge for ${ctx.input.orderId}` });
      return { version: "1.0.0", charged, stamped: stamped.toISOString() };
    },
  },
);

export const orderProcessingV2 = workflow<OrderInput, { version: string; charged: { ok: boolean; amount: number } }>(
  "order-processing",
  {
    version: "2.0.0",
    run: async (ctx) => {
      const charged = await ctx.step("charge-v2", async () => {
        sideEffects.chargesV2 += 1;
        return { ok: true, amount: ctx.input.amount };
      });
      return { version: "2.0.0", charged };
    },
  },
);

export default defineApp({
  workflows: [orderProcessingV1, orderProcessingV2],
});
