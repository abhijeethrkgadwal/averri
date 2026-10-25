/**
 * Public option and result types of `@averri/extract`.
 *
 * The extractors produce `extracted` nodes and edges (SPEC-IR §3) plus a few structured facts the
 * compiler needs that have no node kind of their own (Zod schema shapes, Prisma relation facts,
 * the content hash and the input-file list).
 */

import type { Edge, EntityId, Evidence, Node, NodeId, Router, SourceRange, SymbolRef } from "@averri/ir";

export interface ExtractOptions {
  /** Directories (repo-relative) scanned for TypeScript. Default `["src"]`. */
  sourceRoots?: string[];
  /** Repo-relative path of the Prisma schema, or `null` to skip. Default `"prisma/schema.prisma"`. */
  prismaSchema?: string | null;
  /**
   * Files that build the Hono/Express app (`src/app.ts`). Router instances created in these files and
   * not mounted anywhere are the roots of the mount tree. When omitted, every unmounted instance is a
   * root and an `entry-points-detected` warning is emitted.
   */
  entryPoints?: string[];
  /** Middleware identifier marking an intentionally public route (`publicRoute`). Never guessed. Default `null`. */
  publicMarker?: string | null;
  /** Directory of generated tests, excluded from test discovery and from the content hash. Default `"tests/averri"`. */
  generatedDir?: string;
  /** Globs (relative to the root) of hand-written test files. Default: every `*.test.*` / `*.spec.*` TypeScript file under the root. */
  testGlobs?: string[];
  /** tsconfig used for the ts-morph project (path aliases, module resolution). Default: `<root>/tsconfig.json` when present. */
  tsConfigPath?: string | null;
  /** Repo-relative path of the Averri config module. Default: the first of `averri.config.ts|mts|cts|js|mjs` that exists. */
  configFile?: string | null;
  /** Which extractors to run. Default: all. */
  include?: Partial<Record<"prisma" | "routes" | "zod" | "tests" | "modules", boolean>>;
}

export type ExtractWarningCode =
  | "prisma-schema-missing"
  | "prisma-parse-error"
  | "prisma-unknown-type"
  | "prisma-view-skipped"
  | "prisma-duplicate-model"
  | "entry-points-detected"
  | "entry-point-missing"
  | "router-unreached"
  | "router-mounted-twice"
  | "router-dynamic-mount"
  | "route-dynamic-path"
  | "route-receiver-unresolved"
  | "exposure-duplicate-id"
  | "zod-shape-unresolved"
  | "test-title-dynamic"
  | "source-root-missing";

export interface ExtractWarning {
  code: ExtractWarningCode;
  message: string;
  /** Repo-relative file, when the warning is about one. */
  file?: string;
  src?: SourceRange;
}

/** A Zod object schema found in the project and its top-level field names. */
export interface ZodSchemaFact {
  ref: SymbolRef;
  exported: boolean;
  /** Top-level keys of the object schema (after `extend`/`merge`/`pick`/`omit`). */
  fields: string[];
  /** False when a part of the shape could not be decided statically (spread, call result); `fields` is then the decided subset. */
  complete: boolean;
  /** `"ast"` when derived from the literal, `"checker"` when the TypeChecker's `shape` property resolved it. */
  method: "ast" | "checker";
  evidence: Evidence[];
}

export interface PrismaRelationFact {
  from: EntityId;
  field: string;
  to: EntityId;
  list: boolean;
  optional: boolean;
  /** `@relation(fields: [...])` on this side, when written. */
  fields: string[];
  /** `@relation(references: [...])` on this side, when written. */
  references: string[];
  /** `@relation("name")`, when written. */
  name: string | null;
}

export interface PrismaFacts {
  file: string;
  models: string[];
  enums: Record<string, string[]>;
  relations: PrismaRelationFact[];
}

export interface InputFile {
  path: string;
  /** sha256 hex of the file content. */
  hash: string;
}

export interface ExtractStack {
  prismaSchema: string | null;
  routers: Router[];
  validator: "zod" | null;
  testRunner: "vitest" | null;
  /** Entry points used for the mount tree (configured or detected). */
  entryPoints: string[];
  configFile: string | null;
}

export interface ExtractResult {
  /** Extracted nodes, sorted by id. */
  nodes: Node[];
  /** Extracted edges, deduplicated and sorted by `(kind, from, to)`. */
  edges: Edge[];
  /** Evidence per node id (the same entries as `provenance.evidence`, indexed for the compiler's verifiers). */
  evidence: Record<NodeId, Evidence[]>;
  warnings: ExtractWarning[];
  /** sha256 over the sorted `(path, sha256(content))` list of every input file (SPEC-IR §6). */
  contentHash: string;
  inputFiles: InputFile[];
  zodSchemas: ZodSchemaFact[];
  prisma: PrismaFacts | null;
  stack: ExtractStack;
}

export const EXTRACT_DEFAULTS = {
  sourceRoots: ["src"],
  prismaSchema: "prisma/schema.prisma",
  generatedDir: "tests/averri",
  testGlobs: ["**/*.{test,spec}.{ts,tsx,mts,cts}"],
  configFiles: ["averri.config.ts", "averri.config.mts", "averri.config.cts", "averri.config.js", "averri.config.mjs"],
} as const;
