/**
 * @averri/contracts — the runtime: tier-1 evaluator, `db.*` predicate compiler, guard runner, the
 * declared-mode pipeline (`invoke`/`handle`/`createRuntime`), `toHono`/`toExpress`, the observe-mode
 * Vitest wrapper (`observe`) and the JSONL trace recorder.
 */
export type { EvalEnv, EvalResult, EvaluatedEntry, DbResult, PrismaLike, Row, TransactionFn } from "./types.js";
// The evaluator's minimal model accessor; `PrismaModelLike` is the harness surface (testgen's harness-api.ts).
export type { PrismaModelLike as PrismaModelAccessor } from "./types.js";
export { AverriRuntimeError, errorMessage } from "./errors.js";
export type { AverriRuntimeErrorCode } from "./errors.js";
export { normaliseValue, valuesEqual, compareOrder, compareValues, toJsonValue, serializeResult, deepCopy, lengthOf, isRecord, isDecimalLike } from "./values.js";
export type { CompareOp, OrderOp } from "./values.js";
export { resolveRef, rootValue, evalWhereOperand } from "./refs.js";
export { evaluateExpr, evaluateOperand, evaluateClause } from "./evaluator.js";
export type { ClauseResult } from "./evaluator.js";
export {
  unflattenWhere,
  compileWhere,
  modelOf,
  countRows,
  evaluateDbNode,
  predicateHolds,
  collectDbNodes,
  prefetchDbNodes,
} from "./predicates.js";
export type { DbNode, PrismaWhere, CompiledWhere, PrefetchedDb } from "./predicates.js";
export { runGuard, guardContext } from "./guards.js";
export type { GuardRunInput, GuardRunResult } from "./guards.js";
export { orderByTier, evaluateContract, evaluatePhase, evaluateInvariants, evaluatePolicy } from "./contracts.js";
export type { ContractEvalOptions, ContractOutcome, ContractPhaseRecord, PhaseFailureInfo, PhaseResult, PolicyEvaluation } from "./contracts.js";
export { invoke, handle, PhaseFailure, entityInvariants, outputEntity, ownedListPaths, includeTree, countingClient } from "./pipeline.js";
export type { RuntimeOptions, InvokeOptions } from "./pipeline.js";
export { toHono, toExpress, mergeInput } from "./adapters.js";
export type { HonoAdapterOptions, ExpressAdapterOptions, WithNullableActor, HonoLikeContext, ExpressLikeRequest, ExpressLikeResponse } from "./adapters.js";
export { createRuntime } from "./runtime.js";
export type { Runtime } from "./runtime.js";
export { normaliseRoutePath, compileRoute, matchRoute, findRoute } from "./matcher.js";
export type { CompiledRoute, RouteSegment } from "./matcher.js";
export { observe, installEmitterSpy, createTransport } from "./observe.js";
export type { ObserveWrapperOptions, Transport } from "./observe.js";
export { createTestHarness, collectDeclarations, resolveApp, requestFor, webhookSigner } from "./harness.js";
export { conformInput, sampleSchema } from "./zod-sample.js";
export type { SampleOptions, Sampled } from "./zod-sample.js";
export type {
  AverriTestHarness,
  HarnessInit,
  HarnessInvokeResult,
  HarnessRawRequest,
  HarnessPolicyDecision,
  HarnessModel,
  HarnessTrace,
  HarnessPhase,
  HarnessPhase as PhaseLike,
  HarnessModel as PrismaModelLike,
  HarnessTrace as TraceLike,
  HarnessInvokeResult as InvokeResult,
  HarnessPolicyDecision as PolicyDecision,
} from "./harness.js";
export {
  createTraceRecorder,
  memoryTraceRecorder,
  defaultTraceRecorder,
  defaultTracesDir,
  traceFileName,
  newTraceId,
  pruneTraces,
  readTraceFile,
  actorSummary,
  redactHeaders,
  toRepoRelative,
  currentVitestTest,
} from "./trace.js";
export type { TraceRecorder, MemoryTraceRecorder, FileTraceRecorder, FileTraceRecorderOptions } from "./trace.js";
