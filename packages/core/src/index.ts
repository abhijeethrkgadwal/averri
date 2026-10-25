/**
 * @averri/core — the public declaration API.
 *
 * ```ts
 * import { entity, policy, action, query, event, workflow, integration, e, db, defineConfig } from "@averri/core";
 * ```
 *
 * Types (including `PHASES`, `PHASE_FAILURE`, `AUTHENTICATION_FAILURE`, `SUCCESS_STATUS`) come from
 * `./types.js`; the runtime (constructors, builders, `defineConfig`, the `__averri` marker helpers and the
 * canonical key orders used by `averri fmt`) from the sibling modules. No import-time side effects.
 */
export * from "./types.js";
export { entity, policy, action, query, event, workflow, integration, declarationApi } from "./declarations.js";
export { AVERRI_MARKER, averriMeta, declarationId, isDeclaration } from "./declarations.js";
export type { AverriMeta, AverriMetaOf, ContractRecord, SubjectMeta } from "./declarations.js";
export { e, db, isEventDecl } from "./builders.js";
export { defineConfig, CONFIG_DEFAULTS } from "./config.js";
export { AverriDeclarationError } from "./errors.js";
export {
  CANONICAL_KEY_ORDER,
  CANONICAL_KEY_ORDERS,
  EFFECT_VALUES,
  HTTP_METHOD_VALUES,
  PAYLOAD_TYPE_VALUES,
  WEBHOOK_SCHEME_VALUES,
  WORKFLOW_ENGINE_VALUES,
  RETRY_BACKOFF_VALUES,
  REF_ROOT_VALUES,
  WHERE_OPERATOR_KEYS,
  PHASE_ROOTS,
  DECLARED_ID_RE,
  PASCAL_NAME_RE,
  CLAUSE_NAME_RE,
} from "./literals.js";
export type { DeclarationKind, WhereOperatorKey } from "./literals.js";
export {
  MAX_PATH_DEPTH,
  tierOf,
  tierOfAst,
  isGuard,
  isClause,
  isAnalysableClause,
  isValueOperand,
  isLitScalar,
  normalisePath,
  flattenWhere,
  collectRefs,
  containsDbOp,
  containsEmitted,
} from "./ast.js";
export type { CollectedRef } from "./ast.js";
