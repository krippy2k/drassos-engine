import { WorkflowNotFoundError, WorkflowVersionError } from "../core/errors.ts";
import type { WorkflowDefinition } from "../sdk/types.ts";

export class WorkflowRegistry {
  private readonly byKey = new Map<string, WorkflowDefinition>();
  private readonly latest = new Map<string, string>();

  register(definition: WorkflowDefinition): void {
    this.byKey.set(key(definition.name, definition.version), definition);
    this.latest.set(definition.name, definition.version);
  }

  get(name: string, version?: string): WorkflowDefinition {
    const resolved = version ?? this.latest.get(name);
    if (!resolved) {
      throw new WorkflowNotFoundError(name);
    }
    const found = this.byKey.get(key(name, resolved));
    if (!found) {
      if (version) {
        throw new WorkflowVersionError(`Workflow ${name} version ${version} is not registered`);
      }
      throw new WorkflowNotFoundError(name);
    }
    return found;
  }

  has(name: string, version?: string): boolean {
    if (version) {
      return this.byKey.has(key(name, version));
    }
    return this.latest.has(name);
  }

  list(): WorkflowDefinition[] {
    const names = [...this.latest.keys()];
    return names.map((name) => this.get(name));
  }

  listAll(): WorkflowDefinition[] {
    return [...this.byKey.values()];
  }

  listVersions(name: string): WorkflowDefinition[] {
    return [...this.byKey.values()].filter((definition) => definition.name === name);
  }
}

function key(name: string, version: string): string {
  return `${name}@${version}`;
}
