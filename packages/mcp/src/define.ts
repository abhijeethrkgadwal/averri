/**
 * `defineTool`: one module per tool exporting `{ name, description, inputSchema, handler }`. The handler
 * accepts raw input (parsed with the tool's zod schema), loads the graph through `loadOrBuild` (never
 * serving a stale one), runs the tool body and wraps the result in the envelope.
 */

import { loadOrBuildWithInfo } from "@averri/compiler";
import type { Graph } from "@averri/ir";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { envelope, toolError, type Outcome, type ToolResponse } from "./envelope.js";

export interface ToolRun<S extends z.ZodType> {
  graph: Graph;
  rebuilt: boolean;
  input: z.output<S>;
  ctx: ToolContext;
}

export interface ToolDef<S extends z.ZodType = z.ZodType, T = unknown> {
  name: string;
  /** First sentence of the SPEC-MCP §6 heading plus the budget; < 30 words. */
  description: string;
  inputSchema: S;
  handler(input: unknown, ctx: ToolContext): Promise<ToolResponse<T>>;
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function defineTool<S extends z.ZodType, T>(
  name: string,
  description: string,
  inputSchema: S,
  run: (r: ToolRun<S>) => Promise<Outcome<T>> | Outcome<T>,
): ToolDef<S, T> {
  return {
    name,
    description,
    inputSchema,
    async handler(raw, ctx) {
      const parsed = inputSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return toolError("bad-input", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
      }
      let loaded;
      try {
        loaded = await loadOrBuildWithInfo(ctx.root, ctx.load);
      } catch (e) {
        const diagnostics = (e as { diagnostics?: never }).diagnostics;
        return toolError("build-failed", describeError(e), diagnostics ? { diagnostics } : {});
      }
      let outcome: Outcome<T>;
      try {
        outcome = await run({ graph: loaded.graph, rebuilt: loaded.rebuilt, input: parsed.data, ctx });
      } catch (e) {
        return toolError("build-failed", `${name} failed: ${describeError(e)}`);
      }
      if (!outcome.ok) return outcome;
      return envelope(loaded.graph, loaded.rebuilt, outcome);
    },
  };
}

/** Exactly-one / at-most-one refinements (SPEC-MCP §6). */
export function countGiven(obj: Record<string, unknown>, keys: readonly string[]): number {
  return keys.filter((k) => obj[k] !== undefined).length;
}
