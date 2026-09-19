import { defineApp, workflow } from "@drassos/core";

export interface HelloInput {
  name: string;
}

export const hello = workflow<HelloInput, { message: string }>("hello", async (ctx) => {
  const name = await ctx.step("load-name", async () => ctx.input.name);
  return { message: `hello ${name}` };
});

export default defineApp({
  workflows: [hello],
});
