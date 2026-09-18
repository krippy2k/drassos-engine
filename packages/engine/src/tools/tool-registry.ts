import { UnknownToolError } from "../core/errors.ts";
import type { ToolDefinition } from "../sdk/types.ts";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  require(name: string): ToolDefinition {
    const found = this.tools.get(name);
    if (!found) {
      throw new UnknownToolError(name);
    }
    return found;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  authorize(names: string[]): ToolDefinition[] {
    return names.map((name) => this.require(name));
  }
}
