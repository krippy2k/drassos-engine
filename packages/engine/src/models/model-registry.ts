import { ModelProviderError } from "../core/errors.ts";
import { parseModelRef, type ModelProvider, type ResolvedModel } from "./model-types.ts";

export class ModelRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private defaultName?: string;

  register(name: string, provider: ModelProvider): void {
    this.providers.set(name, provider);
    this.defaultName ??= name;
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  resolve(ref: string): ResolvedModel {
    const parsed = parseModelRef(ref);
    const providerName = parsed.provider ?? this.defaultName;
    if (!providerName) {
      throw new ModelProviderError(`No model provider registered for "${ref}"`);
    }
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new ModelProviderError(`Unknown model provider "${providerName}"`);
    }
    return { provider, model: parsed.model };
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
