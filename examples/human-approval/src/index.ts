import { defineApp, workflow } from "@drassos/core";

export interface PublishInput {
  title: string;
}

export const publishPost = workflow<PublishInput, { title: string; decision: unknown }>(
  "publish-post",
  async (ctx) => {
    const decision = await ctx.approval({
      id: "publish",
      title: `Publish ${ctx.input.title}?`,
    });
    return { title: ctx.input.title, decision };
  },
);

export default defineApp({
  workflows: [publishPost],
});
