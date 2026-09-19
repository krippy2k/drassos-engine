import { defineApp, defineTool, workflow } from "@drassos/core";
import { ScriptedModelProvider } from "@drassos/node";
import { z } from "zod";

export const lookupUser = defineTool({
  name: "lookupUser",
  description: "Look up a user by id",
  input: z.object({ userId: z.string() }),
  handler: async ({ userId }) => ({ userId, name: "Ada", plan: "pro" }),
});

export function createAgentProvider(): ScriptedModelProvider {
  return new ScriptedModelProvider(
    [
      {
        toolCalls: [{ id: "call_1", name: "lookupUser", arguments: { userId: "user_1" } }],
      },
      {
        output: { summary: "Ada is on the pro plan." },
      },
    ],
    "scripted",
  );
}

const summarySchema = z.object({
  summary: z.string(),
});

export const summarizeUser = workflow<{ userId: string }, unknown>("summarize-user", async (ctx) => {
  return ctx.agent("summarize", {
    model: "scripted:demo",
    prompt: `Summarize user ${ctx.input.userId}`,
    tools: ["lookupUser"],
    output: summarySchema,
    maxTurns: 5,
    input: ctx.input,
  });
});

export function createAgentApp() {
  return defineApp({
    workflows: [summarizeUser],
    tools: [lookupUser],
    models: { scripted: createAgentProvider() },
  });
}

export default createAgentApp();
