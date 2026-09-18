import { CapabilityNotFoundError } from "../core/errors.ts";
import type { Capability } from "./types.ts";

export class CapabilityRegistry {
  private readonly byId = new Map<string, Capability>();

  register(capability: Capability): void {
    this.byId.set(capability.id, capability);
  }

  get(id: string): Capability {
    const found = this.byId.get(id);
    if (!found) {
      throw new CapabilityNotFoundError(id);
    }
    return found;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): Capability[] {
    return [...this.byId.values()];
  }

  listBySource(source: Capability["source"]): Capability[] {
    return this.list().filter((item) => item.source === source);
  }
}

export function capabilityId(source: string, provider: string, name: string): string {
  return `${source}:${provider}:${name}`;
}
