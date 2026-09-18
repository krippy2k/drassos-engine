import type { Json } from "./types.ts";

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
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
