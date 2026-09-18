/**
 * Operation identity
 * ------------------
 * Each durable operation is identified by:
 *
 *   (workflowRunId, name, occurrence)
 *
 * `name` is the string passed to ctx.step / ctx.agent / ctx.human / etc.
 * `occurrence` is the 0-based count of how many times that name has already
 * been used during the current execution of the workflow function.
 *
 * Replay walks the same TypeScript control flow, so occurrence values are
 * stable across recovery as long as orchestration code does not introduce
 * non-deterministic branching around durable operations.
 *
 * For loops, use a unique name per iteration (for example `charge-${index}`).
 */

export interface OperationIdentity {
  runId: string;
  name: string;
  occurrence: number;
}

export function operationIdentity(runId: string, name: string, occurrence: number): string {
  return `${runId}:${name}:${occurrence}`;
}

export class OccurrenceCounter {
  private readonly counts = new Map<string, number>();

  next(name: string): number {
    const current = this.counts.get(name) ?? 0;
    this.counts.set(name, current + 1);
    return current;
  }

  peek(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}
