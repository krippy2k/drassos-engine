import type { PayloadCapture } from "./types.ts";
import type { ObservabilityConfig } from "../core/types.ts";

const SECRET_KEY = /secret|password|token|apikey|api_key|authorization|credential|private[_-]?key/i;

export function resolveCapture(
  config: ObservabilityConfig | undefined,
  field:
    | "workflowInputs"
    | "workflowOutputs"
    | "agentInputs"
    | "agentOutputs"
    | "modelPrompts"
    | "modelResponses"
    | "toolArguments"
    | "toolResults",
): PayloadCapture {
  const specific = config?.[field];
  if (specific) {
    return specific;
  }
  if (config?.payloads) {
    return config.payloads;
  }
  if (field === "modelPrompts" && config?.recordPrompts === false) {
    return "disabled";
  }
  if (field === "modelResponses" && config?.recordResponses === false) {
    return "disabled";
  }
  if (field === "toolArguments" && config?.recordToolArguments === false) {
    return "disabled";
  }
  if (field === "toolResults" && config?.recordToolResults === false) {
    return "disabled";
  }
  return "full";
}

export function applyCapture(value: unknown, capture: PayloadCapture): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (capture === "disabled") {
    return undefined;
  }
  const redacted = redactSecrets(value);
  if (capture === "metadata-only") {
    return metadataOnly(redacted);
  }
  return redacted;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(nested);
  }
  return result;
}

function metadataOnly(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    return { type: "object", keys: Object.keys(value as Record<string, unknown>).slice(0, 24) };
  }
  return { type: typeof value };
}
