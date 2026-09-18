import { describe, expect, it } from "vitest";
import {
  CircularDependencyError,
  InvalidDelegationPlanError,
  UnknownAgentError,
  UnknownWorkflowError,
} from "../core/errors.ts";
import type { DelegationPlan } from "../core/types.ts";
import { AgentRegistry } from "./agent-registry.ts";
import { validateDelegationPlan } from "./delegation.ts";
import { WorkflowRegistry } from "./registry.ts";

describe("delegation plan validation", () => {
  it("rejects missing tasks, unknown targets, bad types, and cycles", () => {
    expect(() => validateDelegationPlan({} as DelegationPlan)).toThrow(InvalidDelegationPlanError);

    const agents = new AgentRegistry();
    agents.register({ name: "writer", instructions: "" });
    const workflows = new WorkflowRegistry();
    workflows.register({ name: "child", version: "1", fn: async () => null });

    expect(() =>
      validateDelegationPlan(
        { tasks: [{ id: "a", type: "agent", target: "missing" }] },
        { agents, workflows },
      ),
    ).toThrow(UnknownAgentError);

    expect(() =>
      validateDelegationPlan(
        { tasks: [{ id: "a", type: "workflow", target: "missing" }] },
        { agents, workflows },
      ),
    ).toThrow(UnknownWorkflowError);

    expect(() =>
      validateDelegationPlan({
        tasks: [{ id: "a", type: "tool" as "agent", target: "writer" }],
      }),
    ).toThrow(InvalidDelegationPlanError);

    expect(() =>
      validateDelegationPlan({
        tasks: [
          { id: "a", type: "agent", target: "writer", dependsOn: ["b"] },
          { id: "b", type: "agent", target: "writer", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(CircularDependencyError);

    expect(() =>
      validateDelegationPlan({
        tasks: [{ id: "a", type: "agent", target: "writer", dependsOn: ["ghost"] }],
      }),
    ).toThrow(/unknown task/);
  });

  it("accepts an acyclic plan whose targets exist", () => {
    const agents = new AgentRegistry();
    agents.register({ name: "researcher", instructions: "" });
    agents.register({ name: "writer", instructions: "" });
    const tasks = validateDelegationPlan(
      {
        tasks: [
          { id: "research", type: "agent", target: "researcher", input: { q: 1 } },
          { id: "write", type: "agent", target: "writer", dependsOn: ["research"] },
        ],
      },
      { agents },
    );
    expect(tasks).toHaveLength(2);
  });
});
