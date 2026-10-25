# @averri/ir

The Semantic IR vocabulary every other Averri package shares: node/edge/graph types, the contract AST,
the diagnostic-code registry, the zod schemas that validate `.averri/graph.json`, and pure helpers.
Depends on `zod` only; performs no IO. Normative specs: `docs/SPEC-IR.md`, `docs/SPEC-CONTRACTS.md`
(§3 tier rule, §7 weakening rule), `docs/SPEC-DIAGNOSTICS.md`.

## Modules

| Module | Exports (selection) |
|---|---|
| `types.ts` | all IR types, `NODE_KINDS`, `EDGE_KINDS`, `DIAGNOSTIC_CODES`, `GraphSchema`, `GraphDiffSchema`, … |
| `ids.ts` | `nodeId`, `parseNodeId`, `validateNodeId`, `assertNodeId`, `contractId`/`parseContractId`, `fieldId`/`parseFieldId`, `exposureId`/`parseExposureId`, `generatedTestId`/`handWrittenTestId`/`parseTestId`, `moduleId`, `nodeIdToFileName`/`fileNameToNodeId` (D-24), `isDeclaredId`, `isPascalName`, `isReservedClause`, `isRepoRelativePath`, `compareIds` |
| `ast.ts` | `walkExpr`, `collectRefs`, `collectRefRoots`, `collectDbModels`, `collectDbPredicates`, `collectEmittedEvents`, `collectOps`, `whereLeaves`, `isDbOp`, `tierOf`, `canonicalJson`, `stableHash`, `exprEquals`, `renderExpr` |
| `edges.ts` | `edgeKey`/`parseEdgeKey`, `dedupeEdges` (higher provenance wins), `addEdge`, `sortEdges`, `edgesOfKind`/`edgesFrom`/`edgesTo`/`edgesTouching`, `targetsOf`/`sourcesOf`, `groupEdgesByKind` (the `inspect` view), `provenanceRank`, `minProvenance` |
| `graph.ts` | `sortGraph`, `serializeGraph` (byte-stable `graph.json` text), `computeCounts`, `nodesOfKind`, `sortedNodeIds` |
| `validate.ts` | `validateGraph` / `safeValidateGraph` (rejects `schemaVersion !== GRAPH_SCHEMA_VERSION`, checks key/id and `counts` invariants, strict endpoint checks), `graphIntegrityIssues`, `validateNode`, `validateEdge`, `validateExpr`, `validateDiagnostic`, `validateGraphDiff`, `GraphValidationError` |
| `diagnostics.ts` | `diagnosticInfo`, `lookupDiagnosticCode`, `isDiagnosticCode`, `hasDeterministicFix`, `diagnosticFamily`, `codesOfFamily`, `compareDiagnostics`, `isSeverityAllowed`, `formatDiagnosticId`, `diagnosticConsistencyIssues`, `RESERVED_DIAGNOSTIC_CODES` |
| `health.ts` | `computeHealth(graph, { authMiddleware, staleGeneratedTests })`, `healthRatios`, `middlewareCallee` |
| `depends.ts` | `computeDependsOn` (propagation table, ≤ 2 steps, `attrs.via`), `dependentsOf`, `dependenciesOf`, `affectedBy`, `fieldsNamedByContract` |
| `weaken.ts` | `compareClauses`, `compareWhere`, `classifyContractChange` (SPEC-CONTRACTS §7) |
| `diff.ts` | `diffGraphs(base, head, { ignore })`, `summarizeGraphDiff`, `contractsWeakened`, `opsTouching`, `diffValues`, `renameKey` |

## Behaviour notes

- `diffGraphs` ignores `src`, `provenance`, `summary` and `lastResult` by default (they move with every
  edit or are written by `check`); pass `ignore: []` to report them. Renames are detected by `handler`
  symbol (Action/Query) or `src.file` + method + path (Exposure) with the §2.1 tie rule, and propagate to the
  owner's Contracts and generated Tests. Contract AST changes produce `weaken-contract`,
  `strengthen-contract`, or an undecided `change` whose `target` is the contract id (what
  `contractsWeakened` reports with `op: "change"`).
- `computeDependsOn` gives a computed edge the lowest provenance among the facts it was derived from.
- `computeHealth` cannot read generated test files; pass `staleGeneratedTests` as a count or a
  predicate over generated Test nodes.
- `stableHash` is sha256 of `canonicalJson` (sorted keys, no whitespace).
