import type { AppDeps } from "../context.js";
import type { JobDefinition } from "../lib/jobs.js";
import { inviteFlow } from "./inviteFlow.js";

/** Every job in the application; `registerWorkflows` subscribes each one. */
export const jobs: readonly JobDefinition<never>[] = [inviteFlow as JobDefinition<never>];

export interface Workflows {
  inviteFlow: typeof inviteFlow;
  /** Unsubscribe every workflow from the bus. */
  dispose(): void;
}

/** Subscribe every workflow to `deps.events`, bound to `deps`. */
export function registerWorkflows(deps: AppDeps): Workflows {
  const disposers = jobs.map((job) => job.register(deps.events, deps));
  return {
    inviteFlow,
    dispose() {
      for (const dispose of disposers) dispose();
    },
  };
}
