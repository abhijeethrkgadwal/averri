/**
 * Build-time facts that are not part of the IR but that verifiers and rules need: the declaration
 * sites, the lowered contracts with their source sites (for fix patches), Zod field types from the
 * TypeChecker, and the function bodies to scan. Never serialised.
 */

import type { CallExpression, Node as TsNode, ObjectLiteralExpression } from "ts-morph";
import type { BoolExpr, HttpMethod, ContractId, ContractPhase, ContractTier, Diagnostic, EntityId, NodeId, RefPath, SourceRange } from "@averri/ir";
import type { Construct } from "./lower/core-imports.js";

export interface DeclSite {
  construct: Construct;
  /** The declared id/name string, null when not a static string. */
  id: string | null;
  nodeId: NodeId | null;
  file: string;
  call: CallExpression;
  src: SourceRange;
  /** Name of the `const` the call initialises (`InviteMember`), when any. */
  constName: string | null;
  options: ObjectLiteralExpression | null;
  /** Global source order: (file ascending, byte-wise) then position. */
  order: number;
}

/** A string in source that lowered to a ref (for A3002/A3007/A3010 fixes). */
export interface RefSite {
  ref: RefPath;
  /** `lhs`: a path string on the left (bare paths are rooted at self); `rooted`: the argument of `e.<root>()`; `path`: a path argument of isNull/len/sum/count/exists. */
  kind: "lhs" | "rooted" | "path";
  /** The string as written. */
  raw: string;
  file: string;
  /** Offsets of the string literal node (quotes included). */
  start: number;
  end: number;
  /** Inside the `where` of `exists`/`count`: `self` is the list element. */
  inElement: boolean;
}

export interface WhereKeySite {
  model: string;
  /** Flat dotted key. */
  key: string;
  file: string;
  /** Offsets of the property name node; only for keys written flat (not nested objects). */
  start: number;
  end: number;
  flat: boolean;
}

/** A string literal on the right of a comparison that looks like a reference (A3007). */
export interface RhsRefLiteral {
  value: string;
  file: string;
  start: number;
  end: number;
}

export interface ContractFacts {
  id: ContractId;
  owner: NodeId;
  phase: ContractPhase;
  clause: string;
  tier: ContractTier;
  ast: BoolExpr | null;
  /** The function node of a guard. */
  guard: TsNode | null;
  src: SourceRange;
  file: string;
  prop: TsNode | null;
  sites: RefSite[];
  whereSites: WhereKeySite[];
  rhsRefLiterals: RhsRefLiteral[];
}

export type ZodScalarKind = "string" | "number" | "boolean" | "date" | "enum" | "bigint" | "object" | "array" | "unknown";

export interface ZodFieldType {
  kind: ZodScalarKind;
  /** String/number literal members for enums. */
  values?: string[];
  nullable: boolean;
  optional: boolean;
  /** Offsets of the field's initializer in an inline `z.object({...})`, for A3006 patches. */
  site?: { file: string; start: number; end: number; text: string };
}

export interface InputFacts {
  fields: Map<string, ZodFieldType> | null;
  /** True when the field list comes from the TypeChecker or a complete AST shape. */
  complete: boolean;
  /** Resolved to a Zod schema at all (zod-match applicability). */
  isZod: boolean;
}

/** One option of a declaration's options object. */
export interface OptionProp {
  key: string;
  /** The property node (assignment, shorthand or method). */
  prop: TsNode;
  /** The value expression (initializer, shorthand identifier, or the method itself). */
  value: TsNode;
}

export interface DeclFacts {
  site: DeclSite;
  nodeId: NodeId;
  props: Map<string, OptionProp>;
  /** Option keys in source order (A1005). */
  keys: Array<{ key: string; node: TsNode }>;
  contracts: ContractFacts[];
  input: InputFacts | null;
  /** Fields of a Zod `output` schema. */
  outputFields: Map<string, ZodFieldType> | null;
  outputEntity: EntityId | null;
  subjectEntity: EntityId | null;
  /** `run` function (declared mode) or the resolved `handler` function (observe mode). */
  body: TsNode | null;
  /** True when the `run`/`handler` is a function whose body the scanner can read. */
  bodyResolvable: boolean;
  /** Integration client declaration node. */
  clientDecl: TsNode | null;
  /** Workflow runner declaration/initializer node. */
  runnerNode: TsNode | null;
  /** Integration `webhook.route` as declared (the IR stores only the resolved Exposure). */
  webhookRoute: { method: HttpMethod; path: string } | null;
  /** Where keys of `subject.where` (A3002/A3009). */
  subjectWhereSites: WhereKeySite[];
}

export interface LoweringOutput {
  facts: DeclFacts[];
  diagnostics: Diagnostic[];
}
