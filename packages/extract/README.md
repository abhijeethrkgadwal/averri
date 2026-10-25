# @averri/extract

Extractors for the Averri Semantic IR (SPEC-IR §3–§4). Everything is static: ts-morph and
`@mrleebo/prisma-ast` read the repository; no user module is ever evaluated (D-2). Every node and
edge produced here has `provenance.origin: "extracted"` with evidence and a documented confidence.

```ts
import { extractProject } from "@averri/extract";

const { nodes, edges, evidence, warnings, contentHash, inputFiles, zodSchemas, prisma, stack } =
  extractProject("/path/to/repo", { entryPoints: ["src/app.ts"], publicMarker: "publicRoute" });
```

| Extractor | Produces | Confidence |
|---|---|---|
| Prisma (`extractPrismaSchema`) | `Entity`/`Field` nodes, `Entity -contains-> Field`, `Module -contains-> Entity`, `Entity -persistedBy-> Module`, relation facts | 0.98; 0.9 for a field whose type is unknown (`unsupported`) |
| Hono / Express (`extractRoutes`) | `Exposure` nodes with composed paths, middleware attribution, body schema; `Module -contains-> Exposure`, `Exposure -validatesWith-> Module` | SPEC-IR §4.1 table: 0.98 root, 0.95 via mount prefix / `basePath`, 0.6 dynamic, 0.5 unreached |
| Zod (`extractZodSchemas`) | `zodSchemas` facts (`SymbolRef`, top-level fields, `complete`, `method: ast \| checker`) | — (facts, no node kind) |
| Vitest (`extractTests`) | hand-written `Test` nodes (`Test:<file>:<line>`), `covers` from `// @averri covers ...` and id literals, `Module -contains-> Test` | 0.95 literal title; 0.8 without a `vitest` import; 0.6 dynamic title |
| Modules (`extractModules`) | one `Module` per visited file with `role`, `exports`, `hash`, `lines`; `contentHash` + `inputFiles` | 1 |

Options (`ExtractOptions`): `sourceRoots` (`["src"]`), `prismaSchema` (`"prisma/schema.prisma"`, `null` to skip),
`entryPoints` (auto-detected when omitted, with an `entry-points-detected` warning), `publicMarker`,
`generatedDir` (`"tests/averri"`, excluded from tests and the content hash, D-13), `testGlobs`,
`tsConfigPath`, `configFile`, `include`.

Helpers shared with the compiler: `normalizeRoutePath`, `composePath`, `routePathsMatch` (route-match),
`usePatternMatches`, `middlewareCallee`, `middlewareMatches`, `staticString`, `resolveDeclaration`,
`symbolRefOf`, `loadProject` / `extractFromContext` (reuse one ts-morph project), `contentHashOf`.

Decisions specific to this package are recorded as D-36 in `docs/SPEC-DECISIONS.md`.
