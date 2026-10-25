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

## Running from the repository

`bin` is `./dist/bin.js` (shebang `node`, built by `npm run build`). In the monorepo use `npm run averri -- <command>`, which runs `tsx --conditions=development packages/cli/src/bin.ts` against the TypeScript sources (the `development` export condition). See docs/RELEASING.md.

`fmt` rewrites files by default (`--check` only reports); see D-39 for the deviation from D-22.
