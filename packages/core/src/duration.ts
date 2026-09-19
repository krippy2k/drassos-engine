const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

export function isDurationString(value: string): boolean {
  return DURATION_RE.test(value.trim());
}

export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid duration milliseconds: ${input}`);
    }
    return input;
  }
  const match = DURATION_RE.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${input}. Use values like 30s, 5m, 24h, 7d.`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  return amount * (UNIT_MS[unit] ?? 1);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function durationMsBetween(start: string | Date, end: string | Date): number {
  return new Date(end).getTime() - new Date(start).getTime();
}
