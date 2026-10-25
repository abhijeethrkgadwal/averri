# @averri/cli

The `averri` command line. Every tool command is a thin mirror of an `@averri/mcp` tool module: with
`--json` it prints exactly the text the MCP server would send (`serialize(callTool(...))`); without it
a human rendering (picocolors). Graph logic lives in `@averri/compiler`.

```
averri [--root <dir>] <command>

init                      averri.config.ts, src/averri.d.ts, agent block in CLAUDE.md / AGENTS.md /
                          .cursor/rules/averri.mdc, devDependencies in package.json; prints MCP snippets
build [--json]            build the graph, write .averri/ and tests/averri/*.gen.test.ts
check [--scope affected|all] [--base <ref>] [--acknowledge-weakening] [--json]
docs [--openapi <file>] [--no-spec]   SPEC.md per declaration directory + OpenAPI json
report --base <ref> [--json]          impact + diagnostics vs a git ref (.averri/reports/<sha>.json)
fmt [--check] [files...]              canonical declaration key order (ts-morph)
testgen [--only <ids...>]             regenerate generated tests
suggest [id]                          draft observe-mode declarations (a diff, never applied)
mcp [--http <port>]                   stdio MCP server, or streamable HTTP on /mcp
overview | find <q> | inspect <id> | impact [id] | explain [id]     each with --json
```

Exit codes: `0` ok, `1` error-level diagnostics, failed tests/check or a failed tool call
(`not-found`, `ambiguous`, `low-confidence`, `build-failed`), `2` usage or `bad-input`.

## Programmatic use

```ts
import { run } from "@averri/cli";
const code = await run(["find", "invite", "--json"], { cwd, stdout, stderr, stdin, color: false });
```

## Running before the release build

`bin` points at `src/bin.ts` (shebang `tsx`). During development use `npx tsx packages/cli/src/bin.ts`.
The published package compiles `src` to `dist` and re-points `bin` at `dist/bin.js` (release pipeline,
not part of this package yet).

`fmt` rewrites files by default (`--check` only reports); see D-39 for the deviation from D-22.
