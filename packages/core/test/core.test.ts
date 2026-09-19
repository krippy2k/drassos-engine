import { describe, expect, it } from "vitest";
import { isDurationString, parseDuration } from "../src/duration.ts";
import { computeBackoffMs, normalizeRetry, shouldRetry } from "../src/retry.ts";
import { OccurrenceCounter, operationIdentity } from "../src/identity.ts";
import { canTransition, isTerminalStatus, transitionRun } from "../src/status.ts";
import { CancellationError, DrassosError, serializeError } from "../src/errors.ts";
import { toJson } from "../src/serialize.ts";
import { defineTool, tool, workflow } from "../src/index.ts";

describe("parseDuration", () => {
  it("parses units and milliseconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration(1500)).toBe(1500);
    expect(isDurationString("10s")).toBe(true);
    expect(isDurationString("sleep")).toBe(false);
  });

  it("rejects invalid values", () => {
    expect(() => parseDuration("soon")).toThrow(/Invalid duration/);
    expect(() => parseDuration(-1)).toThrow(/Invalid duration/);
  });
});

describe("retry policy", () => {
  it("computes fixed and exponential backoff", () => {
    expect(computeBackoffMs({ maxAttempts: 3, backoff: "none" }, 1)).toBe(0);
    expect(computeBackoffMs({ maxAttempts: 3, backoff: "fixed", initialIntervalMs: 200 }, 1)).toBe(200);
    expect(
      computeBackoffMs(
        { maxAttempts: 5, backoff: "exponential", initialIntervalMs: 100, multiplier: 2, maxIntervalMs: 1000 },
        1,
      ),
    ).toBe(100);
    expect(
      computeBackoffMs(
        { maxAttempts: 5, backoff: "exponential", initialIntervalMs: 100, multiplier: 2, maxIntervalMs: 1000 },
        3,
      ),
    ).toBe(400);
    expect(
      computeBackoffMs(
        { maxAttempts: 5, backoff: "exponential", initialIntervalMs: 100, multiplier: 2, maxIntervalMs: 250 },
        5,
      ),
    ).toBe(250);
  });

  it("tracks remaining attempts", () => {
    const policy = normalizeRetry({ maxAttempts: 3, backoff: "fixed" });
    expect(shouldRetry(policy, 1)).toBe(true);
    expect(shouldRetry(policy, 3)).toBe(false);
  });
});

describe("operation identity", () => {
  it("is stable for name plus occurrence", () => {
    const counter = new OccurrenceCounter();
    expect(counter.next("charge")).toBe(0);
    expect(counter.next("charge")).toBe(1);
    expect(counter.next("notify")).toBe(0);
    expect(operationIdentity("run-1", "charge", 1)).toBe("run-1:charge:1");
  });
});

describe("workflow state transitions", () => {
  it("allows the documented lifecycle", () => {
    expect(transitionRun("PENDING", "start")).toBe("RUNNING");
    expect(transitionRun("RUNNING", "wait")).toBe("WAITING");
    expect(transitionRun("WAITING", "resume")).toBe("RUNNING");
    expect(transitionRun("RUNNING", "complete")).toBe("COMPLETED");
    expect(canTransition("COMPLETED", "start")).toBe(false);
    expect(isTerminalStatus("FAILED")).toBe(true);
    expect(isTerminalStatus("WAITING")).toBe(false);
    expect(() => transitionRun("COMPLETED", "cancel")).toThrow(/Invalid workflow transition/);
  });
});

describe("error serialization", () => {
  it("distinguishes internal and user errors", () => {
    const internal = serializeError(new DrassosError("boom"));
    const user = serializeError(new Error("charge failed"), { attempt: 2, operationId: "op-1" });
    const cancelled = serializeError(new CancellationError());
    expect(internal.type).toBe("internal");
    expect(user.type).toBe("user");
    expect(user.attempt).toBe(2);
    expect(user.operationId).toBe("op-1");
    expect(cancelled.name).toBe("CancellationError");
    expect(toJson({ at: new Date("2026-01-01T00:00:00.000Z") })).toEqual({ at: "2026-01-01T00:00:00.000Z" });
  });
});

describe("public aliases", () => {
  it("treats defineTool as tool", () => {
    expect(defineTool).toBe(tool);
    const ping = workflow("ping", async () => "ok");
    expect(ping.name).toBe("ping");
    expect(ping.version).toBe("1");
  });
});
