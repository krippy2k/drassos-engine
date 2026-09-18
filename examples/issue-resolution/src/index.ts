import {
  agent,
  defineApp,
  mcp,
  tool,
  workflow,
  type AgentProvider,
  type AgentRequest,
  type AgentResult,
} from "@drassos/engine";
import { z } from "zod";

export const demoState = {
  files: {
    "src/app.ts": "export function add(a: number, b: number) { return a - b; }\n",
  } as Record<string, string>,
  testRuns: 0,
  pullRequests: 0,
};

export function resetDemoState(): void {
  demoState.files = {
    "src/app.ts": "export function add(a: number, b: number) { return a - b; }\n",
  };
  demoState.testRuns = 0;
  demoState.pullRequests = 0;
}

export const github = mcp.memory("github", [
  {
    name: "get_issue",
    description: "Fetch a GitHub issue",
    execute: async (input) => {
      const { issue, repository } = input as { issue: number; repository: string };
      return {
        number: issue,
        repository,
        title: "add() subtracts instead of adding",
        body: "Calling add(2, 2) returns 0.",
      };
    },
  },
  {
    name: "get_file",
    description: "Fetch a repository file",
    execute: async (input) => {
      const { path } = input as { path: string };
      return { path, content: demoState.files[path] ?? "" };
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request",
    execute: async (input) => {
      demoState.pullRequests += 1;
      const { title } = input as { title: string };
      return { number: demoState.pullRequests, title, url: `https://github.com/acme/widgets/pull/${demoState.pullRequests}` };
    },
  },
]);

const filesystem = mcp.memory("filesystem", [
  {
    name: "read_file",
    description: "Read a local file",
    execute: async (input) => {
      const { path } = input as { path: string };
      return { path, content: demoState.files[path] ?? "" };
    },
  },
  {
    name: "write_file",
    description: "Write a local file",
    execute: async (input) => {
      const { path, content } = input as { path: string; content: string };
      demoState.files[path] = content;
      return { path, written: true };
    },
  },
]);

export const runTestsTool = tool({
  name: "run_tests",
  description: "Run the repository test suite",
  input: z.object({}),
  execute: async () => {
    demoState.testRuns += 1;
    const source = demoState.files["src/app.ts"] ?? "";
    const passing = source.includes("return a + b");
    if (!passing) {
      return { passed: false, output: "FAIL add(2,2) expected 4 received 0" };
    }
    return { passed: true, output: "PASS" };
  },
});

class ScriptedToolAgent implements AgentProvider {
  readonly name: string;
  constructor(
    name: string,
    private readonly plan: Array<
      | { tool: string; args: Record<string, unknown> }
      | { output: unknown }
    >,
  ) {
    this.name = name;
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const completed = request.messages.filter((message) => message.role === "tool").length;
    const next = this.plan[completed];
    if (!next) {
      return { output: { ok: true }, model: this.name };
    }
    if ("output" in next) {
      return { output: next.output, model: this.name, tokenInput: 40, tokenOutput: 20 };
    }
    return {
      output: null,
      toolCalls: [{ id: `call_${completed + 1}`, name: next.tool, arguments: JSON.parse(JSON.stringify(next.args)) }],
      model: this.name,
      tokenInput: 24,
      tokenOutput: 12,
    };
  }
}

export const triageAgent = agent({
  name: "triage",
  model: "claude-sonnet",
  system: "You investigate software issues.",
  tools: [github],
  limits: { maxTurns: 10, maxToolCalls: 20, timeout: "5m" },
  provider: new ScriptedToolAgent("triage", [
    { tool: "get_issue", args: { issue: 42, repository: "acme/widgets" } },
    { tool: "get_file", args: { path: "src/app.ts" } },
    {
      output: {
        summary: "add() uses subtraction",
        files: ["src/app.ts"],
      },
    },
  ]),
});

export const researchAgent = agent({
  name: "research",
  model: "claude-sonnet",
  system: "You research related code and history.",
  tools: [github],
  limits: { maxTurns: 8, maxToolCalls: 10, timeout: "5m" },
  provider: new ScriptedToolAgent("research", [
    { tool: "get_file", args: { path: "src/app.ts" } },
    { output: { rootCause: "operator should be +", recommendation: "fix add() and re-run tests" } },
  ]),
});

export const codingAgent = agent({
  name: "coding",
  model: "claude-sonnet",
  system: "You implement the fix and run tests.",
  tools: [filesystem, runTestsTool],
  limits: { maxTurns: 12, maxToolCalls: 20, timeout: "5m" },
  provider: new ScriptedToolAgent("coding", [
    { tool: "read_file", args: { path: "src/app.ts" } },
    { tool: "run_tests", args: {} },
    {
      tool: "write_file",
      args: { path: "src/app.ts", content: "export function add(a: number, b: number) { return a + b; }\n" },
    },
    { tool: "run_tests", args: {} },
    { output: { patch: "src/app.ts", tests: "pass" } },
  ]),
});

export interface IssueInput {
  issue: number;
  repository: string;
}

export const researchIssue = workflow<IssueInput & { analysis?: unknown }, unknown>(
  "research-issue",
  async (ctx) => {
    await ctx.sleep("research-window", 80);
    return ctx.agent.run(researchAgent, {
      prompt: `Research issue ${ctx.input.issue} in ${ctx.input.repository}`,
      input: ctx.input,
    });
  },
  { version: "1" },
);

export const implementIssue = workflow<{ analysis: unknown; research: unknown }, unknown>(
  "implement-issue",
  async (ctx) => {
    return ctx.agent.run(codingAgent, {
      prompt: "Implement the recommended fix and run tests",
      input: ctx.input,
    });
  },
  { version: "1" },
);

export const issueResolution = workflow<IssueInput, unknown>(
  "issue-resolution",
  async (ctx) => {
    const analysis = await ctx.agent.run(triageAgent, {
      prompt: `Investigate issue ${ctx.input.issue}`,
      input: ctx.input,
    });

    const research = await ctx.workflow.run(researchIssue, {
      ...ctx.input,
      analysis,
    });

    const implementation = await ctx.workflow.run(implementIssue, { analysis, research });

    await ctx.human.approve({
      title: "Approve implementation?",
      data: { analysis, research, implementation },
    });

    const pullRequest = await ctx.step("create-pull-request", async () => {
      demoState.pullRequests += 1;
      return {
        number: demoState.pullRequests,
        title: `Fix issue ${ctx.input.issue}`,
        url: `https://github.com/${ctx.input.repository}/pull/${demoState.pullRequests}`,
      };
    });

    return { analysis, research, implementation, pullRequest };
  },
  { version: "1" },
);

export default defineApp({
  workflows: [issueResolution, researchIssue, implementIssue],
});
