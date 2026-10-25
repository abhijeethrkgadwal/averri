/**
 * @averri/compiler — build pipeline, graph cache, impact, check, explain, spec cards, OpenAPI and the
 * graph queries behind the MCP/CLI tools. Never evaluates user modules (D-2).
 */

export { build, writeGeneratedTests, sameGeneratedContent, AVERRI_VERSION, type BuildOptions, type BuildResult, type GeneratedFilesReport } from "./build.js";
export { loadOrBuild, loadOrBuildWithInfo, isFresh, type LoadOptions, type LoadResult } from "./load.js";
export { readConfig, lowerConfigText, findConfigFile, CONFIG_DEFAULTS, CONFIG_FILES, type LoweredConfig, type ConfigResult } from "./config.js";
export { computeContentHash, inputFiles } from "./inputs.js";
export {
  AVERRI_DIR,
  averriDir,
  cachePath,
  readCachedGraph,
  writeCachedGraph,
  readGraphFile,
  readSnapshot,
  readSnapshotByHash,
  writeSnapshot,
  pruneSnapshots,
  readLastCheck,
  writeLastCheck,
  readLastGreen,
  writeLastGreen,
  readLastGreenGraph,
  acquireBuildLock,
  SNAPSHOT_LIMIT,
  type LastCheck,
  type LastGreen,
  type TestRunRecord,
  type Lock,
} from "./cache.js";
export { gitInfo, gitHead, gitDirty, gitDiff, gitChangedFiles, gitLogFile, gitBlameAuthor, gitWorktreeAt } from "./git.js";
export { buildAtRef, buildWithDiffReverted } from "./revisions.js";
export { diff, impactOfIds, impactOfDiff, impactOfGraphs, apiBreaking, nodesTouchedBy, resolveNodeId, verifyNote, type ImpactResult, type ResolvedId } from "./impact.js";
export { nodeHistory, type HistoryOptions } from "./history.js";
export { check, withLastResults, type CheckOptions, type CheckResult, type CheckData, type CheckFailure } from "./check/check.js";
export { collapseTscErrors, diffSymbols, nodeAt, usefulTitle, type DiffSymbol, type CollapseOptions } from "./check/tsc-collapse.js";
export { runTsc, type TscError } from "./check/tsc.js";
export { runVitest, parseVitestJson, testIdOf, contractOf, rerunCommand, type VitestAssertion, type VitestReport, type VitestRunner } from "./check/vitest.js";
export { explain, chainFor, type ExplainInput, type ExplainData, type ExplainOptions, type ChainRole } from "./explain.js";
export { readTraces, findTrace, tracesForTest, tracesDir, type TraceRecord, type TracePhaseRecord } from "./traces.js";
export { specCard, renderCardMarkdown, writeCards, whoMay, type SpecCard } from "./cards.js";
export { toOpenApi, openApiPath, type OpenApiDocument } from "./openapi.js";
export { renderClause, renderWhere, renderOperand } from "./render.js";
export { overview, QUICKSTART, type OverviewData } from "./query/overview.js";
export { find, matchClass, KIND_PRIORITY, type FindInput, type FindHit } from "./query/find.js";
export { inspect, type InspectInput, type InspectData, type InspectOptions } from "./query/inspect.js";
export { impactQuery, boundImpact, type ImpactInput, type ImpactQueryOptions } from "./query/impact.js";
export { BUDGETS, MORE_CAP, capMore, responseTokens, type Bounded, type QueryError, type QueryResult } from "./query/budget.js";
export { emit, finalizeDiagnostics, patchFix, DIAGNOSTIC_CHAR_BUDGET, type DiagnosticDraft } from "./diagnostics.js";
export { makePatch, applyEdits, parseUnifiedDiff, applyFilePatch, patchApplies, reversePatch, changedLines, MAX_PATCH_CHARS, type TextEdit, type ParsedFilePatch, type ChangedFile } from "./patch.js";
export { RULES } from "./rules/index.js";
export { CANONICAL_KEY_ORDERS } from "./rules/A1005.js";
