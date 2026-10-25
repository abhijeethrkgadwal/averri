/**
 * @averri/testgen — generates `tests/averri/*.gen.test.ts` from the Semantic IR (SPEC-CONTRACTS §9).
 * Pure: no IO, no randomness; the compiler writes the files.
 */

export * from "./types.js";
export * from "./harness-api.js";
export { generateTests, planTests, resolveOptions, ownersOf, buildOwnerFiles, DEFAULT_GENERATED_DIR, DEFAULT_CONFIG_FILE, DEFAULT_NUM_RUNS } from "./generate.js";
export { deriveTestNodes, testNodeOf, type DerivedTests } from "./nodes.js";
export { sourceHashOf, derivationInputs, writersOf, consumersOf, stripVolatile } from "./hash.js";
export { parseGeneratedHeader, isGeneratedTestStale, GENERATED_HEADER_RE } from "./header.js";
export { renderHeader, HEADER_PREFIX, HELPERS } from "./prelude.js";
export { analyseClause, mergeConjunction, negateAtom, rootsOf, type Atom, type Conjunction, type ClauseAnalysis, type FieldConstraint, type MergeResult } from "./constraints.js";
export { arbitrarySource, valueTypeOfField, valueTypeOfLiteral, valueTypeOfName, isIsoDate, type ValueType, type ValueKind } from "./arbitraries.js";
export { constrainedArbitrary, inputArbitrary, satisfyAll, violateOne, buildActionModel, type ActionModel, type InputField, type SourceResult } from "./model.js";
export { planRow, planPredicateSeed, planSubjectSeed, leafSources, refSource, alteredLiteral, notInSample, MAX_RELATION_DEPTH, type RowRequest, type RowResult, type SeedResult } from "./fixtures.js";
export { SchemaFacts } from "./schema.js";
export { relativeImport, ident, litSource } from "./emit.js";
export { moduleFileOf, buildOwnerFile, type OwnerFile } from "./file.js";
