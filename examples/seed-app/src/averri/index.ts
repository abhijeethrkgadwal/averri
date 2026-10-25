/**
 * Every Averri declaration of the seed app, in one list for `observe(app, { declarations, config })`.
 * Observe mode only: nothing here is wired into the request path or the test suite yet (the
 * integration step does that).
 */
import type { Declaration } from "@averri/core";
import { actions } from "./actions.js";
import { entities } from "./entities.js";
import { events } from "./events.js";
import { integrations } from "./integrations.js";
import { policies } from "./policies.js";
import { queries } from "./queries.js";
import { workflows } from "./workflows.js";

export * from "./actions.js";
export * from "./entities.js";
export * from "./events.js";
export * from "./integrations.js";
export * from "./policies.js";
export * from "./queries.js";
export * from "./workflows.js";

export const declarations: readonly Declaration[] = [...entities, ...policies, ...events, ...actions, ...queries, ...workflows, ...integrations];
