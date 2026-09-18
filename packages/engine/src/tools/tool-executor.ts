import {
  ToolInputValidationError,
  ToolOutputValidationError,
  UnauthorizedToolError,
  UnknownToolError,
} from "../core/errors.ts";
import type { ToolContext, ToolDefinition } from "../sdk/types.ts";

export function selectAuthorizedTool(name: string, allowed: ToolDefinition[]): ToolDefinition {
  const tool = allowed.find((candidate) => candidate.name === name);
  if (!tool) {
    if (allowed.length === 0) {
      throw new UnknownToolError(name);
    }
    throw new UnauthorizedToolError(name);
  }
  return tool;
}

export async function executeAuthorizedTool(
  tool: ToolDefinition,
  input: unknown,
  context: ToolContext,
): Promise<unknown> {
  let parsed: unknown = input;
  if (tool.input) {
    const result = tool.input.safeParse(input);
    if (!result.success) {
      throw new ToolInputValidationError(tool.name, result.error.message);
    }
    parsed = result.data;
  }
  const output = await tool.execute(parsed, context);
  if (tool.output) {
    const checked = tool.output.safeParse(output);
    if (!checked.success) {
      throw new ToolOutputValidationError(tool.name, checked.error.message);
    }
    return checked.data;
  }
  return output;
}
