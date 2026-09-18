import { UnknownAgentError } from "../core/errors.ts";
import type { AgentDefinition } from "../sdk/types.ts";

export class AgentRegistry {
  private readonly byName = new Map<string, AgentDefinition>();

  register(definition: AgentDefinition): void {
    this.byName.set(definition.name, definition);
  }

  get(name: string): AgentDefinition {
    const found = this.byName.get(name);
    if (!found) {
      throw new UnknownAgentError(name);
    }
    return found;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): AgentDefinition[] {
    return [...this.byName.values()];
  }
}
