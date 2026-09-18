import type { Logger as PinoLogger } from "pino";
import pino from "pino";

export type Logger = PinoLogger;

export function createLogger(options?: { level?: string; name?: string }): Logger {
  return pino({
    name: options?.name ?? "drassos",
    level: options?.level ?? process.env.DRASSOS_LOG_LEVEL ?? "info",
  });
}
