import type { ModelCallRecord, ObservabilityConfig } from "../core/types.ts";

export const DEFAULT_MODEL_RATES: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  default: { inputPerMillion: 1, outputPerMillion: 3 },
};

export function estimateModelCostUsd(
  call: Pick<ModelCallRecord, "model" | "tokenInput" | "tokenOutput">,
  config?: ObservabilityConfig,
): number | null {
  const input = call.tokenInput ?? 0;
  const output = call.tokenOutput ?? 0;
  if (input === 0 && output === 0) {
    return null;
  }
  const rates = config?.modelRates ?? DEFAULT_MODEL_RATES;
  const key = call.model && rates[call.model] ? call.model : "default";
  const rate = rates[key] ?? DEFAULT_MODEL_RATES.default!;
  return (input * rate.inputPerMillion + output * rate.outputPerMillion) / 1_000_000;
}

export function aggregateTokens(calls: Array<Pick<ModelCallRecord, "tokenInput" | "tokenOutput">>): {
  tokenInput: number;
  tokenOutput: number;
} {
  return calls.reduce(
    (sum: { tokenInput: number; tokenOutput: number }, call) => ({
      tokenInput: sum.tokenInput + (call.tokenInput ?? 0),
      tokenOutput: sum.tokenOutput + (call.tokenOutput ?? 0),
    }),
    { tokenInput: 0, tokenOutput: 0 },
  );
}
