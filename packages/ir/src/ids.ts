/**
 * Node id construction, parsing and validation (SPEC-IR §2.1) plus file-safe encoding (D-24).
 * Pure functions; no IO.
 */

import {
  NODE_KINDS,
  ROUTERS,
  type ContractId,
  type ContractPhase,
  type EntityId,
  type ExposureId,
  type FieldId,
  type GeneratedTestSuite,
  type ModuleId,
  type NodeId,
  type NodeKind,
  type Router,
  type TestId,
} from "./types.js";

const KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);
const ROUTER_SET: ReadonlySet<string> = new Set(ROUTERS);

/** Generated-test suites, longest first so suffix matching on `gen/<owner>.<suite>` is unambiguous. */
export const GENERATED_TEST_SUITES: readonly GeneratedTestSuite[] = [
  "pitfall.webhook-signature",
  "pitfall.idempotency",
  "pitfall.raw-body",
  "postcondition",
  "precondition",
  "auth-matrix",
  "invariant",
  "consumer",
  "event",
] as const;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9_]*$/;
const CLAUSE_RE = /^\$?[A-Za-z_][A-Za-z0-9_]*$/;
const DECLARED_ID_RE = /^[A-Z][A-Za-z0-9_]*\.[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `<Scope>.<name>` with a capitalised scope and exactly one dot (SPEC-DECLARATIONS §3). */
export function isDeclaredId(qualifier: string): boolean {
  return DECLARED_ID_RE.test(qualifier);
}

/** PascalCase name used by entities, events, workflows and integrations. */
export function isPascalName(name: string): boolean {
  return PASCAL_RE.test(name);
}

/** camelCase/identifier clause name; `$`-prefixed names are syntactically valid but reserved (see {@link isReservedClause}). */
export function isClauseName(name: string): boolean {
  return CLAUSE_RE.test(name);
}

/** Clause names starting with `$` are reserved for synthetic contracts (`requires.$subject`); declaring one is A1004. */
export function isReservedClause(clause: string): boolean {
  return clause.startsWith("$");
}

/** Repo-relative POSIX path: non-empty, no leading `./` or `/`, no backslashes, no `..` segments, no trailing slash. */
export function isRepoRelativePath(file: string): boolean {
  if (file.length === 0) return false;
  if (file.includes("\\")) return false;
  if (file.startsWith("/")) return false;
  if (file.endsWith("/")) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  const segments = file.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Build an id from a kind and qualifier. Throws on an empty qualifier; does not check the per-kind grammar (use {@link validateNodeId}). */
export function nodeId<K extends NodeKind>(kind: K, qualifier: string): `${K}:${string}` {
  if (!KIND_SET.has(kind)) throw new Error(`unknown node kind "${String(kind)}"`);
  if (qualifier.length === 0) throw new Error(`empty qualifier for ${kind} id`);
  return `${kind}:${qualifier}`;
}

export interface ParsedNodeId {
  kind: NodeKind;
  qualifier: string;
}

/** Split `<Kind>:<qualifier>`; returns `null` when the prefix is not a known kind or the qualifier is empty. */
export function parseNodeId(id: string): ParsedNodeId | null {
  const colon = id.indexOf(":");
  if (colon <= 0) return null;
  const kind = id.slice(0, colon);
  const qualifier = id.slice(colon + 1);
  if (!KIND_SET.has(kind) || qualifier.length === 0) return null;
  return { kind: kind as NodeKind, qualifier };
}

/** True when the string has the `<Kind>:<qualifier>` shape with a known kind (shape only; see {@link validateNodeId} for grammar). */
export function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && parseNodeId(value) !== null;
}

export function kindOf(id: NodeId): NodeKind {
  const parsed = parseNodeId(id);
  if (!parsed) throw new Error(`malformed node id "${id}"`);
  return parsed.kind;
}

export function qualifierOf(id: NodeId): string {
  const parsed = parseNodeId(id);
  if (!parsed) throw new Error(`malformed node id "${id}"`);
  return parsed.qualifier;
}

export function isKind<K extends NodeKind>(id: string, kind: K): id is `${K}:${string}` {
  return id.startsWith(`${kind}:`) && id.length > kind.length + 1;
}

// --- per-kind constructors ---------------------------------------------------

export function entityId(model: string): EntityId {
  return nodeId("Entity", model);
}

export function fieldId(entity: EntityId | string, field: string): FieldId {
  const model = isKind(entity, "Entity") ? qualifierOf(entity) : entity;
  return nodeId("Field", `${model}.${field}`);
}

export interface ParsedFieldId {
  entity: EntityId;
  model: string;
  field: string;
}

export function parseFieldId(id: string): ParsedFieldId | null {
  const parsed = parseNodeId(id);
  if (!parsed || parsed.kind !== "Field") return null;
  const dot = parsed.qualifier.indexOf(".");
  if (dot <= 0 || dot === parsed.qualifier.length - 1) return null;
  const model = parsed.qualifier.slice(0, dot);
  const field = parsed.qualifier.slice(dot + 1);
  if (field.includes(".")) return null;
  return { entity: entityId(model), model, field };
}

/**
 * Contract id: `<ownerQualifier>.<phase>.<clause>`; for the `allow` phase the clause is omitted
 * (`Contract:Team.OwnerOrAdmin.allow`). `owner` may be a node id or a bare qualifier.
 */
export function contractId(owner: NodeId | string, phase: ContractPhase, clause: string | null): ContractId {
  const ownerQualifier = parseNodeId(owner)?.qualifier ?? owner;
  if (phase === "allow") {
    if (clause !== null && clause !== "allow") throw new Error(`allow contracts take no clause name (got "${clause}")`);
    return nodeId("Contract", `${ownerQualifier}.allow`);
  }
  if (clause === null || clause.length === 0) throw new Error(`${phase} contracts need a clause name`);
  if (clause.includes(".")) throw new Error(`clause name "${clause}" must not contain "."`);
  return nodeId("Contract", `${ownerQualifier}.${phase}.${clause}`);
}

export interface ParsedContractId {
  ownerQualifier: string;
  phase: ContractPhase;
  /** `allow` for policy contracts. */
  clause: string;
}

const CONTRACT_RE = /^(.+)\.(requires|ensures|invariant)\.([^.]+)$/;

export function parseContractId(id: string): ParsedContractId | null {
  const parsed = parseNodeId(id);
  if (!parsed || parsed.kind !== "Contract") return null;
  const m = CONTRACT_RE.exec(parsed.qualifier);
  if (m) return { ownerQualifier: m[1]!, phase: m[2] as ContractPhase, clause: m[3]! };
  if (parsed.qualifier.endsWith(".allow") && parsed.qualifier.length > ".allow".length) {
    return { ownerQualifier: parsed.qualifier.slice(0, -".allow".length), phase: "allow", clause: "allow" };
  }
  return null;
}

export function exposureId(router: Router, file: string, line: number, col: number): ExposureId {
  return nodeId("Exposure", `${router}:${file}:${line}:${col}`);
}

export interface ParsedExposureId {
  router: Router;
  file: string;
  line: number;
  col: number;
}

const INT_RE = /^(0|[1-9]\d*)$/;

export function parseExposureId(id: string): ParsedExposureId | null {
  const parsed = parseNodeId(id);
  if (!parsed || parsed.kind !== "Exposure") return null;
  const q = parsed.qualifier;
  const firstColon = q.indexOf(":");
  if (firstColon <= 0) return null;
  const router = q.slice(0, firstColon);
  if (!ROUTER_SET.has(router)) return null;
  const rest = q.slice(firstColon + 1);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const colStr = rest.slice(lastColon + 1);
  const beforeCol = rest.slice(0, lastColon);
  const midColon = beforeCol.lastIndexOf(":");
  if (midColon <= 0) return null;
  const lineStr = beforeCol.slice(midColon + 1);
  const file = beforeCol.slice(0, midColon);
  if (!INT_RE.test(lineStr) || !INT_RE.test(colStr)) return null;
  const line = Number(lineStr);
  const col = Number(colStr);
  if (line < 1 || file.length === 0) return null;
  return { router: router as Router, file, line, col };
}

export function generatedTestId(owner: NodeId | string, suite: GeneratedTestSuite): TestId {
  const ownerQualifier = parseNodeId(owner)?.qualifier ?? owner;
  return nodeId("Test", `gen/${ownerQualifier}.${suite}`);
}

export function handWrittenTestId(file: string, line: number): TestId {
  return nodeId("Test", `${file}:${line}`);
}

export type ParsedTestId =
  | { generated: true; ownerQualifier: string; suite: GeneratedTestSuite }
  | { generated: false; file: string; line: number };

export function parseTestId(id: string): ParsedTestId | null {
  const parsed = parseNodeId(id);
  if (!parsed || parsed.kind !== "Test") return null;
  const q = parsed.qualifier;
  if (q.startsWith("gen/")) {
    const body = q.slice(4);
    for (const suite of GENERATED_TEST_SUITES) {
      const suffix = `.${suite}`;
      if (body.endsWith(suffix) && body.length > suffix.length) {
        return { generated: true, ownerQualifier: body.slice(0, -suffix.length), suite };
      }
    }
    return null;
  }
  const lastColon = q.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const lineStr = q.slice(lastColon + 1);
  if (!INT_RE.test(lineStr) || Number(lineStr) < 1) return null;
  return { generated: false, file: q.slice(0, lastColon), line: Number(lineStr) };
}

export function moduleId(file: string): ModuleId {
  return nodeId("Module", file);
}

// --- validation ----------------------------------------------------------------

export interface NodeIdValidation {
  ok: boolean;
  kind: NodeKind | null;
  qualifier: string | null;
  /** Empty when `ok`. Each entry is one human-readable problem. */
  problems: string[];
}

/** Check an id against the per-kind qualifier grammar of SPEC-IR §2.1. */
export function validateNodeId(id: string): NodeIdValidation {
  const parsed = parseNodeId(id);
  if (!parsed) {
    const colon = id.indexOf(":");
    const problem =
      colon <= 0
        ? `"${id}" is not of the form <Kind>:<qualifier>`
        : KIND_SET.has(id.slice(0, colon))
          ? `"${id}" has an empty qualifier`
          : `"${id}" has unknown kind "${id.slice(0, colon)}" (expected one of ${NODE_KINDS.join(", ")})`;
    return { ok: false, kind: null, qualifier: null, problems: [problem] };
  }
  const { kind, qualifier } = parsed;
  const problems: string[] = [];
  switch (kind) {
    case "Entity":
      if (!PASCAL_RE.test(qualifier)) problems.push(`Entity qualifier "${qualifier}" must be a PascalCase model name`);
      break;
    case "Field": {
      const f = parseFieldId(id);
      if (!f) problems.push(`Field qualifier "${qualifier}" must be <Entity>.<field>`);
      else {
        if (!PASCAL_RE.test(f.model)) problems.push(`Field entity "${f.model}" must be a PascalCase model name`);
        if (!IDENT_RE.test(f.field)) problems.push(`Field name "${f.field}" must be an identifier`);
      }
      break;
    }
    case "Action":
    case "Query":
    case "Policy":
      if (!isDeclaredId(qualifier)) {
        problems.push(`${kind} qualifier "${qualifier}" must be <Scope>.<name> with a capitalised scope and exactly one dot`);
      }
      break;
    case "Contract": {
      const c = parseContractId(id);
      if (!c) {
        problems.push(`Contract qualifier "${qualifier}" must be <owner>.<requires|ensures|invariant>.<clause> or <policy>.allow`);
      } else {
        if (c.phase === "invariant" && !PASCAL_RE.test(c.ownerQualifier)) {
          problems.push(`invariant owner "${c.ownerQualifier}" must be a PascalCase entity name`);
        }
        if (c.phase !== "invariant" && !isDeclaredId(c.ownerQualifier)) {
          problems.push(`${c.phase} owner "${c.ownerQualifier}" must be a declared id <Scope>.<name>`);
        }
        if (c.phase !== "allow" && !CLAUSE_RE.test(c.clause)) problems.push(`clause name "${c.clause}" must be an identifier`);
      }
      break;
    }
    case "Event":
    case "Workflow":
    case "Integration":
      if (!PASCAL_RE.test(qualifier)) problems.push(`${kind} qualifier "${qualifier}" must be a PascalCase name`);
      break;
    case "Exposure": {
      const e = parseExposureId(id);
      if (!e) problems.push(`Exposure qualifier "${qualifier}" must be <hono|express>:<file>:<line>:<col>`);
      else if (!isRepoRelativePath(e.file)) problems.push(`Exposure file "${e.file}" must be a repo-relative POSIX path`);
      break;
    }
    case "Test": {
      const t = parseTestId(id);
      if (!t) problems.push(`Test qualifier "${qualifier}" must be gen/<owner>.<suite> or <file>:<line>`);
      else if (!t.generated && !isRepoRelativePath(t.file)) problems.push(`Test file "${t.file}" must be a repo-relative POSIX path`);
      break;
    }
    case "Module":
      if (!isRepoRelativePath(qualifier)) problems.push(`Module qualifier "${qualifier}" must be a repo-relative POSIX path`);
      break;
  }
  return { ok: problems.length === 0, kind, qualifier, problems };
}

/** Throwing form of {@link validateNodeId}. */
export function assertNodeId(id: string): asserts id is NodeId {
  const v = validateNodeId(id);
  if (!v.ok) throw new Error(v.problems.join("; "));
}

// --- file-safe encoding (D-24) --------------------------------------------------

/** Reversible file-safe form of an id for `.averri/cards/<name>.md` and friends: `encodeURIComponent(id)`. */
export function nodeIdToFileName(id: NodeId): string {
  return encodeURIComponent(id);
}

/** Inverse of {@link nodeIdToFileName}; accepts a bare name or a path and strips a trailing `.md`/`.json`. */
export function fileNameToNodeId(fileName: string): NodeId | null {
  let base = fileName;
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  if (slash >= 0) base = base.slice(slash + 1);
  const ext = /\.(md|json)$/.exec(base);
  if (ext) base = base.slice(0, -ext[0].length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    return null;
  }
  return isNodeId(decoded) ? decoded : null;
}

/** Code-unit-wise string comparison used for every id ordering in the graph (byte order for ASCII ids). */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
