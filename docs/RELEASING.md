# Releasing

How the eight packages are built, packed, verified like a user and published. First release: `0.1.0-alpha.0`
(npm dist-tag `alpha`). Nothing here has been published; the pack-and-install run below used local tarballs only.

Packages, in dependency order: `@averri/ir`, `@averri/core`, `@averri/extract`, `@averri/testgen`,
`@averri/contracts`, `@averri/compiler`, `@averri/mcp`, `@averri/cli` (bin `averri`). `examples/seed-app`
(`@averri/seed-app`) and `bench` are private and never published.

## How the packaging works

- **Build:** `npm run build` runs `tsc -b tsconfig.build.json`. Each `packages/<p>/tsconfig.json` is `composite`
  with `references` to the packages it imports, so `tsc -b` builds in dependency order and is incremental
  (state in `packages/<p>/.tsbuildinfo`, not shipped). Chosen over per-package `tsc` because one invocation orders the
  build, skips up-to-date packages and resolves `@averri/*` types through the referenced projects' output.
  Output: `packages/<p>/dist` with `.js`, `.d.ts` and `.js.map`. `npm run clean` removes every `dist/` and `.tsbuildinfo`;
  `npm run build:clean` does both.
- **Exports:** `{ ".": { "development": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } }`.
  In the repo the `development` condition resolves sources: root `tsconfig.json` (`customConditions`), `vitest.config.ts` and
  `examples/seed-app/vitest.config.ts` (`resolve.conditions`/`ssr.resolve.conditions`), `examples/seed-app/tsconfig.json`, and
  `tsx --conditions=development` (root `npm run averri`, seed-app scripts, the MCP e2e test's `node --conditions=development --import tsx`).
  The package build tsconfigs do not set it, so dist is built against dist `.d.ts`.
- **Pack:** each package has `prepack`/`postpack` hooks (`scripts/pack-hooks.mjs`). `prepack` runs `tsc -b` (a pack can never ship
  stale or missing dist), copies the root `LICENSE` into the package and removes the `development` condition from the packed
  `package.json` (it points at `./src`, which is not published, and a consumer's Vite/Vitest would otherwise pick it). `postpack`
  restores `package.json` and deletes the LICENSE copy. `files` is `["dist", "README.md", "LICENSE"]`.
- **Fixture caveat:** compiler/CLI tests analyse fixture projects with ts-morph's default options, which see the `types` condition
  (dist `.d.ts`). `vitest.global-setup.ts` runs `tsc -b` first so `npx vitest run` works from a clean checkout.
- **Dependencies:** internal deps are pinned to `0.1.0-alpha.0`; every external import is declared in the importing package
  (`ts-morph`, `fast-glob`, `zod`, `commander`, `picocolors`, `@mrleebo/prisma-ast`, `@modelcontextprotocol/sdk`). Peers: `zod` (core);
  optional peers on `@averri/contracts`: `vitest`, `fast-check`, `@prisma/client`, `hono`, `express`; optional on `@averri/testgen`: `fast-check`.
  Generated tests import only `vitest`, `fast-check` and `@averri/contracts` (`createTestHarness` and types, all in its dist exports);
  `averri init` adds `@averri/core`, `@averri/contracts`, `vitest` and `fast-check` to the project's `package.json`.
- **Embedded assets:** the MCP docs (`averri://docs/*`), agent block, init templates and spec text are TypeScript string constants, so no file
  is read relative to `import.meta.url` except the CLI's own `../package.json` (for `--version`), which is in every tarball.
- **MCP registration** printed by `init`: `claude mcp add averri -- npx -y @averri/cli mcp` (and the same in `.mcp.json` / `.cursor/mcp.json`).

## Release procedure

1. Start from a clean `main`; `npm ci`; `npm run db:generate -w @averri/seed-app`.
2. Bump versions if not `0.1.0-alpha.0`: every `packages/*/package.json` `version`, every internal dependency/devDependency pin
   (and `examples/seed-app`), `AVERRI_VERSION` in `packages/compiler/src/build.ts` and `SERVER_VERSION` in `packages/mcp/src/server.ts`;
   then `npm install` to refresh `package-lock.json`.
3. `npm run typecheck` and `npm test` (about 6-9 minutes).
4. `npm run build:clean`.
5. `npm run smoke:pack` (or `node scripts/smoke-pack.mjs --skip-build --dir "%TEMP%\averri-pack"` to keep the temp project and tarballs
   for inspection). It packs all eight packages, inspects the tarballs, installs them into a fresh project outside the repo and runs
   the user-level commands below. CI runs the same script (`pack-smoke` job in `.github/workflows/ci.yml`).
6. Publish (needs an npm account with rights to the `@averri` scope and 2FA): `npm publish --workspaces --tag alpha`.
   The root and the private workspaces (`@averri/seed-app`, `bench`) are skipped because they are `private`. `publishConfig.access` is
   `public`. npm publishes workspaces in dependency order.
   Dry run first: `npm publish --workspaces --tag alpha --dry-run`.
7. Tag: `git tag v0.1.0-alpha.0 && git push origin v0.1.0-alpha.0`.
8. Check from a scratch directory: `npm view @averri/cli@alpha version` and `npx -y @averri/cli@alpha --version`.

## Pack-and-install verification (what `scripts/smoke-pack.mjs` does)

Run on Windows 11, Node 20.19.0, npm 10.8.2, 2026-10-25. Temp dir `%TEMP%\averri-pack` (tarballs in `tarballs\`, the user project
in `app\`), both outside the repo. The project is `scripts/smoke-fixture` (Hono + Prisma/SQLite: one model, one policy, one action, one query).
No `tsx`, no `NODE_OPTIONS`, no repo on the module path.

```
# in the repo
npm run build                                  # tsc -b tsconfig.build.json            -> exit 0
cd packages/<p> && npm pack --pack-destination %TEMP%\averri-pack\tarballs --silent
  # for ir core extract testgen contracts compiler mcp cli:  averri-<p>-0.1.0-alpha.0.tgz   -> exit 0 each
tar -tzf / tar -xzOf package/package.json      # each tarball: dist/index.js, dist/index.d.ts, LICENSE, README.md present,
                                               # no src/ or test/, no "development" condition, version 0.1.0-alpha.0, cli bin ./dist/bin.js

# in %TEMP%\averri-pack\app  (fresh project copied from scripts/smoke-fixture)
npm install hono@^4 @hono/node-server zod@^4 @prisma/client@^6 @types/node@^20          # added 6 packages
npm install --save-dev prisma@^6 vitest@^2 typescript@^5 <the eight .tgz paths>       # added 219 packages
npx prisma generate                            # Generated Prisma Client (v6.19.3)
DATABASE_URL=file:./dev.db npx prisma db push --skip-generate
npx averri --version                           # 0.1.0-alpha.0
npx averri init                                # created src/averri.d.ts, CLAUDE.md, AGENTS.md, .cursor/rules/averri.mdc;
                                               # prints "claude mcp add averri -- npx -y @averri/cli mcp" and JSON snippets
npm install                                    # init added fast-check to devDependencies
npx averri build                               # built 24 nodes, 99 edges; generated tests: 2 written
                                               # 0 error(s), 0 warning(s), 1 info (A4002: no handler to scan)
npx averri overview --json                     # {"ok":true,... "stack":{"orm":"prisma","routers":["hono"],"validator":"zod",...}}
npx averri testgen                             # 0 written, 2 unchanged, 0 deleted (tests/averri/Note.create.gen.test.ts, Note.list.gen.test.ts)
npx averri check --json                        # exit 0; data.tests {ran:8, passed:8, failed:0}, green:true
node smoke-mcp.mjs                             # MCP SDK client over stdio to node_modules/@averri/cli/dist/bin.js mcp:
                                               # {"server":{"name":"averri","version":"0.1.0-alpha.0"},
                                               #  "tools":["overview","find","inspect","impact","check","explain","read_source","suggest"]}
```

Result: 28 steps, all PASS. The generated tests import only `@averri/contracts` (plus `vitest` and `fast-check`).

Notes from running it: `prisma generate` and `npm install` occasionally fail on Prisma's engine download with `ECONNRESET`; the script
retries network steps up to three times. On Windows an interrupted `npm install` can leave `node_modules\@averri\*\dist` locked (EPERM); delete
the temp dir and re-run.

## Known limits of this alpha

- `averri overview` reports `testRunner: null` in the smoke project because it has no hand-written Vitest tests (the extractor sets it from discovered tests, not from package.json); it does not affect `check`.
- Source maps point at `../src/*.ts`, which is not published (maps resolve only in the repo).
- Not verified: `npm publish` itself, `npx -y @averri/cli mcp` against the real registry (the smoke test starts the same binary from `node_modules`), Express in an installed project.
