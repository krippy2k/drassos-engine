import { WorkflowNotFoundError, WorkflowRegistrationError, WorkflowVersionError } from "../core/errors.ts";
import { isValidWorkflowVersion, workflowKey } from "../core/version.ts";
import type { WorkflowDefinition } from "../sdk/types.ts";

export class WorkflowRegistry {
  private readonly byKey = new Map<string, WorkflowDefinition>();
  private readonly latest = new Map<string, string>();
  private readonly defaults = new Map<string, string>();

  constructor(private readonly options?: { allowReplace?: boolean; enforceVersions?: boolean }) {}

  setDefault(name: string, version: string): void {
    this.defaults.set(name, version);
  }

  register(definition: WorkflowDefinition): void {
    if (!isValidWorkflowVersion(definition.version)) {
      throw new WorkflowRegistrationError(`Invalid workflow version "${definition.version}" for "${definition.name}"`);
    }
    if (this.options?.enforceVersions && !/^\d+\.\d+\.\d+/.test(definition.version)) {
      throw new WorkflowRegistrationError(`Workflow "${definition.name}" requires a semantic version when enforcement is enabled`);
    }
    const id = workflowKey(definition.name, definition.version);
    if (this.byKey.has(id) && !this.options?.allowReplace) {
      throw new WorkflowRegistrationError(`Workflow "${id}" is already registered.`);
    }
    this.byKey.set(id, definition);
    this.latest.set(definition.name, definition.version);
  }

  get(name: string, version?: string): WorkflowDefinition {
    const resolved = version ?? this.defaults.get(name) ?? this.latest.get(name);
    if (!resolved) {
      throw new WorkflowNotFoundError(name);
    }
    const found = this.byKey.get(workflowKey(name, resolved));
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
      return this.byKey.has(workflowKey(name, version));
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

  grouped(): Array<{ name: string; versions: string[]; defaultVersion: string }> {
    const names = [...new Set([...this.byKey.values()].map((item) => item.name))];
    return names.map((name) => {
      const versions = this.listVersions(name).map((item) => item.version);
      return {
        name,
        versions,
        defaultVersion: this.defaults.get(name) ?? this.latest.get(name) ?? versions[0] ?? "1",
      };
    });
  }

  advertised(): string[] {
    return this.listAll().map((item) => workflowKey(item.name, item.version));
  }
}
