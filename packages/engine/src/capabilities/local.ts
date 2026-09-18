import { executeAuthorizedTool } from "../tools/tool-executor.ts";
import type { AgentDefinition, ToolDefinition, WorkflowDefinition } from "../sdk/types.ts";
import type { Capability, CapabilityExecutionContext, CapabilityResult } from "./types.ts";
import { capabilityId } from "./registry.ts";

export function localToolCapability(tool: ToolDefinition): Capability {
  return {
    id: capabilityId("local", "tool", tool.name),
    name: tool.name,
    description: tool.description,
    kind: "tool",
    source: "local",
    provider: "local",
    retry: tool.retry,
    async invoke(input, context: CapabilityExecutionContext): Promise<CapabilityResult> {
      const output = await executeAuthorizedTool(tool, input, {
        runId: context.runId ?? "",
        workflowId: context.runId ?? "",
        agentExecutionId: context.executionId ?? "",
        toolCallId: context.clientRequestId,
        idempotencyKey: context.clientRequestId,
        abortSignal: context.abortSignal,
      });
      return { output, status: "completed" };
    },
  };
}

export function localAgentCapability(agent: AgentDefinition): Capability {
  return {
    id: capabilityId("local", "agent", agent.name),
    name: agent.name,
    description: agent.instructions,
    kind: "agent",
    source: "local",
    provider: "local",
    async invoke(input): Promise<CapabilityResult> {
      return { output: input, status: "completed" };
    },
  };
}

export function localWorkflowCapability(workflow: WorkflowDefinition): Capability {
  return {
    id: capabilityId("local", "workflow", workflow.name),
    name: workflow.name,
    kind: "workflow",
    source: "local",
    provider: "local",
    async invoke(input): Promise<CapabilityResult> {
      return { output: input, status: "completed" };
    },
  };
}
