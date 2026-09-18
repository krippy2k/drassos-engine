import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export class WorkNotifier {
  private readonly events = new EventEmitter();

  constructor() {
    this.events.setMaxListeners(0);
  }

  ping(): void {
    this.events.emit("work");
  }

  wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const onWork = () => {
        clearTimeout(timer);
        this.events.off("work", onWork);
        resolve();
      };
      const timer = setTimeout(() => {
        this.events.off("work", onWork);
        resolve();
      }, timeoutMs);
      this.events.once("work", onWork);
    });
  }
}

export function newId(): string {
  return randomUUID();
}
