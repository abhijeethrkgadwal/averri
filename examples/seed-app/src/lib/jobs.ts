/**
 * A tiny custom job engine: a job subscribes to one event on the `EventBus`, runs named steps with
 * bounded retries, and records what happened. It stands in for Inngest / pg-boss in the reference
 * app (Averri classifies it as `engine: "custom"`).
 *
 * Job definitions are static module-level objects (so `workflow({ runner })` can reference them);
 * the application dependencies are bound at registration time (`job.register(bus, deps)`).
 */
import type { AppDeps } from "../context.js";
import type { DomainEvent, EventBus } from "../events.js";

export interface StepApi {
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

export interface JobRun {
  jobId: string;
  event: DomainEvent;
  steps: Array<{ name: string; attempts: number; ok: boolean; error?: string }>;
  ok: boolean;
  error?: string;
}

export type JobDeps = Pick<AppDeps, "db" | "mailer" | "config" | "stripe" | "now">;

export interface JobDefinition<Data extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly event: string;
  readonly retry: { attempts: number; backoff: "fixed" | "exponential" };
  /** Every completed run, oldest first (in-memory; tests inspect it). */
  readonly runs: JobRun[];
  register(bus: EventBus, deps: JobDeps): () => void;
  handle(event: DomainEvent<Data>, deps: JobDeps): Promise<JobRun>;
}

export interface JobOptions<Data extends Record<string, unknown>> {
  id: string;
  /** The exact bus event name, e.g. `"averri/MemberInvited"`. Keep it a string literal for static scanning. */
  event: string;
  retry?: { attempts?: number; backoff?: "fixed" | "exponential" };
  run(ctx: { event: DomainEvent<Data>; step: StepApi; deps: JobDeps }): Promise<void>;
}

export function defineJob<Data extends Record<string, unknown>>(options: JobOptions<Data>): JobDefinition<Data> {
  const retry = { attempts: options.retry?.attempts ?? 3, backoff: options.retry?.backoff ?? "fixed" } as const;
  const runs: JobRun[] = [];

  async function handle(event: DomainEvent<Data>, deps: JobDeps): Promise<JobRun> {
    const record: JobRun = { jobId: options.id, event, steps: [], ok: true };
    const step: StepApi = {
      async run<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
        const entry: JobRun["steps"][number] = { name, attempts: 0, ok: false };
        record.steps.push(entry);
        let lastError: unknown;
        for (let attempt = 1; attempt <= retry.attempts; attempt++) {
          entry.attempts = attempt;
          try {
            const value = await fn();
            entry.ok = true;
            return value;
          } catch (error) {
            lastError = error;
          }
        }
        entry.error = lastError instanceof Error ? lastError.message : String(lastError);
        throw lastError;
      },
    };
    try {
      await options.run({ event, step, deps });
    } catch (error) {
      record.ok = false;
      record.error = error instanceof Error ? error.message : String(error);
    }
    runs.push(record);
    return record;
  }

  return {
    id: options.id,
    event: options.event,
    retry,
    runs,
    handle,
    register(bus, deps) {
      return bus.on(options.event, (event) => handle(event as DomainEvent<Data>, deps).then(() => undefined));
    },
  };
}
