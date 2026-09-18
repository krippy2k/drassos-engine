import { UnserializableValueError } from "./errors.ts";
import type { Json } from "./types.ts";

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

export function assertSerializable(value: unknown, label = "value"): Json {
  const seen = new Set<unknown>();
  const walk = (current: unknown, path: string): void => {
    if (current === undefined) {
      throw new UnserializableValueError(`${label} contains undefined at ${path}`);
    }
    const kind = typeof current;
    if (kind === "function" || kind === "symbol" || kind === "bigint") {
      throw new UnserializableValueError(`${label} contains non-JSON ${kind} at ${path}`);
    }
    if (current && kind === "object") {
      if (seen.has(current)) {
        throw new UnserializableValueError(`${label} contains a circular reference at ${path}`);
      }
      seen.add(current);
      if (Array.isArray(current)) {
        current.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (current instanceof Date) {
        return;
      }
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
        walk(nested, `${path}.${key}`);
      }
    }
  };
  walk(value ?? null, label);
  try {
    return toJson(value);
  } catch (error) {
    throw new UnserializableValueError(
      `${label} could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseJson(value: unknown): Json {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Json;
    } catch {
      return value;
    }
  }
  return value as Json;
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function requiredIso(value: Date | string | null | undefined): string {
  return toIso(value) ?? new Date().toISOString();
}
