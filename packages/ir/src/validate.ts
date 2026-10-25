/**
 * Graph validation (SPEC-IR §1, §6, §11): `GraphSchema` plus the invariants the schema cannot express
 * (schema version, key/id agreement, counts). Readable errors; no IO.
 */

import type { z } from "zod";

import {
  BoolExprSchema,
  DiagnosticSchema,
  EdgeSchema,
  GRAPH_SCHEMA_VERSION,
  GraphDiffSchema,
  GraphSchema,
  NodeSchema,
  type BoolExpr,
  type Diagnostic,
  type Edge,
  type Graph,
  type GraphDiff,
  type Node,
} from "./types.js";
import { computeCounts, sumCounts } from "./graph.js";
import { NODE_KINDS, type NodeKind } from "./types.js";
import { validateNodeId } from "./ids.js";

/** Thrown by the `validate*` functions. `issues` is one readable line per problem (`<path>: <message>`). */
export class GraphValidationError extends Error {
  readonly issues: readonly string[];
  constructor(what: string, issues: readonly string[]) {
    const shown = issues.slice(0, 10);
    const more = issues.length > shown.length ? `\n  ... and ${issues.length - shown.length} more` : "";
    super(`${what} is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n  ${shown.join("\n  ")}${more}`);
    this.name = "GraphValidationError";
    this.issues = issues;
  }
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Render zod issues as `path: message` lines. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "$" : issue.path.map((p) => (typeof p === "number" ? `[${p}]` : String(p))).join(".");
    return `${path}: ${issue.message}`;
  });
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): ValidationResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: formatZodIssues(result.error) };
}

export interface ValidateGraphOptions {
  /**
   * Also check every node id against the per-kind qualifier grammar and every edge endpoint against
   * `nodes`. Default `true`; a cache failing these is corrupt and must be rebuilt.
   */
  strict?: boolean;
}

/** Non-throwing form of {@link validateGraph}. */
export function safeValidateGraph(json: unknown, options: ValidateGraphOptions = {}): ValidationResult<Graph> {
  const strict = options.strict ?? true;
  const version = (json as { meta?: { schemaVersion?: unknown } } | null)?.meta?.schemaVersion;
  if (typeof json !== "object" || json === null) return { ok: false, issues: ["$: graph must be an object"] };
  if (version !== GRAPH_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [`meta.schemaVersion: expected ${GRAPH_SCHEMA_VERSION}, got ${JSON.stringify(version)}; the cache must be rebuilt`],
    };
  }
  const parsed = parseWith(GraphSchema, json);
  if (!parsed.ok) return parsed;
  const graph = parsed.value;
  const issues = graphIntegrityIssues(graph, strict);
  return issues.length === 0 ? { ok: true, value: graph } : { ok: false, issues };
}

/**
 * Validate a parsed `graph.json`; wraps `GraphSchema.parse` and rejects any `schemaVersion` other than
 * `GRAPH_SCHEMA_VERSION` (callers rebuild). Throws {@link GraphValidationError}.
 */
export function validateGraph(json: unknown, options: ValidateGraphOptions = {}): Graph {
  const result = safeValidateGraph(json, options);
  if (!result.ok) throw new GraphValidationError("graph", result.issues);
  return result.value;
}

/**
 * Invariants beyond the schema: `nodes[id].id === id`, `counts` match the nodes and sum to the key
 * count, and (strict) ids follow the per-kind grammar and edges reference existing nodes.
 */
export function graphIntegrityIssues(graph: Graph, strict = true): string[] {
  const issues: string[] = [];
  for (const [key, node] of Object.entries(graph.nodes)) {
    if (node.id !== key) issues.push(`nodes.${key}: key does not match node.id "${node.id}"`);
    if (strict) {
      const v = validateNodeId(node.id);
      if (!v.ok) issues.push(`nodes.${key}.id: ${v.problems.join("; ")}`);
      else if (v.kind !== node.kind) issues.push(`nodes.${key}: id kind "${v.kind}" does not match node.kind "${node.kind}"`);
    }
  }
  const actual = computeCounts(graph.nodes);
  for (const kind of NODE_KINDS) {
    const declared = graph.meta.counts[kind as NodeKind];
    if (declared !== actual[kind]) issues.push(`meta.counts.${kind}: expected ${actual[kind]} (from nodes), got ${declared}`);
  }
  const keyCount = Object.keys(graph.nodes).length;
  const sum = sumCounts(graph.meta.counts);
  if (sum !== keyCount) issues.push(`meta.counts: sum ${sum} does not equal the number of nodes ${keyCount}`);
  if (strict) {
    graph.edges.forEach((e, i) => {
      if (!graph.nodes[e.from]) issues.push(`edges[${i}]: from "${e.from}" is not a node`);
      if (!graph.nodes[e.to]) issues.push(`edges[${i}]: to "${e.to}" is not a node`);
    });
  }
  return issues;
}

export function safeValidateNode(json: unknown): ValidationResult<Node> {
  return parseWith(NodeSchema, json);
}

export function validateNode(json: unknown): Node {
  const r = safeValidateNode(json);
  if (!r.ok) throw new GraphValidationError("node", r.issues);
  return r.value;
}

export function safeValidateEdge(json: unknown): ValidationResult<Edge> {
  return parseWith(EdgeSchema, json);
}

export function validateEdge(json: unknown): Edge {
  const r = safeValidateEdge(json);
  if (!r.ok) throw new GraphValidationError("edge", r.issues);
  return r.value;
}

export function safeValidateExpr(json: unknown): ValidationResult<BoolExpr> {
  return parseWith(BoolExprSchema, json);
}

export function validateExpr(json: unknown): BoolExpr {
  const r = safeValidateExpr(json);
  if (!r.ok) throw new GraphValidationError("contract expression", r.issues);
  return r.value;
}

export function safeValidateDiagnostic(json: unknown): ValidationResult<Diagnostic> {
  return parseWith(DiagnosticSchema, json);
}

export function validateDiagnostic(json: unknown): Diagnostic {
  const r = safeValidateDiagnostic(json);
  if (!r.ok) throw new GraphValidationError("diagnostic", r.issues);
  return r.value;
}

export function safeValidateGraphDiff(json: unknown): ValidationResult<GraphDiff> {
  return parseWith(GraphDiffSchema, json);
}

export function validateGraphDiff(json: unknown): GraphDiff {
  const r = safeValidateGraphDiff(json);
  if (!r.ok) throw new GraphValidationError("graph diff", r.issues);
  return r.value;
}
