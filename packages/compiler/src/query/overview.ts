/** `overview` (SPEC-MCP §6.1): session orientation, <= 1 200 tokens; drops `topModules` first. */

import { healthRatios, type Graph, type HealthCounters, type NodeKind, type StackSummary } from "@averri/ir";
import { compareStrings } from "../util.js";
import { BUDGETS, responseTokens, type Bounded } from "./budget.js";

export interface OverviewData {
  stack: StackSummary;
  counts: Record<NodeKind, number>;
  health: HealthCounters & { opaqueGuardRatio: number; handlerLineRatio: number; handlerLineRatioNote: "informational in V0" };
  topModules: Array<{ file: string; actions: number; exposures: number }>;
  quickstart: string;
}

export const QUICKSTART = [
  "Call find or impact before editing an entity, route, policy or contract; ids look like Action:Team.inviteMember.",
  "Run check instead of raw tsc/vitest; it regenerates tests/averri/*.gen.test.ts (never edit those).",
  "Contracts: left side is a path string (\"result.email\"), right side is e.<root>() or a literal.",
  "Prefer e.*/db.* clauses; bare async guards are opaque and get no generated tests.",
  "On low-confidence or verify notes, use read_source; prefer the first fix on a diagnostic.",
].join("\n");

const round = (x: number | null): number => (x === null ? 0 : Math.round(x * 1000) / 1000);

export function overview(graph: Graph): Bounded<OverviewData> {
  const ratios = healthRatios(graph.meta.health);
  const perFile = new Map<string, { actions: number; exposures: number }>();
  for (const n of Object.values(graph.nodes)) {
    if (!n.src || (n.kind !== "Action" && n.kind !== "Query" && n.kind !== "Exposure")) continue;
    const e = perFile.get(n.src.file) ?? { actions: 0, exposures: 0 };
    if (n.kind === "Exposure") e.exposures++;
    else e.actions++;
    perFile.set(n.src.file, e);
  }
  const topModules = [...perFile.entries()]
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.actions + b.exposures - (a.actions + a.exposures) || compareStrings(a.file, b.file))
    .slice(0, 8);
  const data: OverviewData = {
    stack: graph.meta.stack,
    counts: graph.meta.counts,
    health: {
      ...graph.meta.health,
      opaqueGuardRatio: round(ratios.opaqueGuardRatio),
      handlerLineRatio: round(ratios.handlerLineRatio),
      handlerLineRatioNote: "informational in V0",
    },
    topModules,
    quickstart: QUICKSTART,
  };
  let truncated = false;
  while (responseTokens(data) > BUDGETS.overview && data.topModules.length > 0) {
    data.topModules.pop();
    truncated = true;
  }
  return { data, truncated };
}
