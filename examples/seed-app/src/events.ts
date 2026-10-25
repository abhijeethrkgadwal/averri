/**
 * The in-process event bus. Services publish domain events after their transaction commits with
 * `bus.send({ name: "averri/<Event>", data })`; workflows (`src/workflows`) subscribe by name.
 *
 * Averri's observe wrapper spies on `send` (`averri.config.ts` → `emitter.spy`), and `consumer-scan`
 * matches the string literal `"averri/<Event>"` in workflow definitions, which is why names are built
 * with the `EVENT_PREFIX` constant and never computed at runtime.
 */
export const EVENT_PREFIX = "averri/";

export interface DomainEvent<Data extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  data: Data;
}

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();
  /** Every event sent through this bus, oldest first. Useful in tests; cleared with `reset()`. */
  readonly sent: DomainEvent[] = [];
  /** Handler failures are isolated from the request that emitted the event; they land here. */
  readonly failures: Array<{ event: DomainEvent; error: unknown }> = [];

  on(name: string, handler: EventHandler): () => void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => {
      const current = this.handlers.get(name) ?? [];
      this.handlers.set(
        name,
        current.filter((h) => h !== handler),
      );
    };
  }

  /** Publish and await every subscriber. A throwing subscriber never fails the publisher. */
  async send(event: DomainEvent): Promise<void> {
    this.sent.push(event);
    const list = this.handlers.get(event.name) ?? [];
    for (const handler of list) {
      try {
        await handler(event);
      } catch (error) {
        this.failures.push({ event, error });
      }
    }
  }

  subscriberCount(name: string): number {
    return (this.handlers.get(name) ?? []).length;
  }

  reset(): void {
    this.sent.length = 0;
    this.failures.length = 0;
  }
}

/** Default bus used by `src/server.ts` and referenced by `averri.config.ts` for the spy. */
export const events = new EventBus();

export function eventName(name: string): string {
  return `${EVENT_PREFIX}${name}`;
}
