import type { AuthRef } from "./types.ts";

export function secretRef(name: string): AuthRef {
  return { kind: "secret-ref", name };
}

export interface AuthProvider {
  resolve(ref: AuthRef): Promise<Record<string, string>>;
}

export const envAuthProvider: AuthProvider = {
  async resolve(ref) {
    if (ref.kind === "none") {
      return {};
    }
    if (ref.kind === "headers") {
      return { ...ref.headers };
    }
    const value = process.env[ref.name];
    if (!value) {
      return {};
    }
    return { authorization: value.startsWith("Bearer ") ? value : `Bearer ${value}` };
  },
};

export function sanitizeAuth(ref: AuthRef | undefined): AuthRef | undefined {
  if (!ref) {
    return undefined;
  }
  if (ref.kind === "headers") {
    return { kind: "secret-ref", name: "[headers omitted]" };
  }
  return ref;
}
