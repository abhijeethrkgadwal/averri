# Getting started

Averri is not published to npm yet. Everything below runs from a checkout of this repository. Each
command was run on Windows 11 (Git Bash) with Node 20.19 during the 2026-10-25 integration pass;
the exceptions are marked **not run here** and the reason is given.

`$AVERRI` below is the absolute path of your checkout (for example `/c/src/averri` or `/home/me/averri`).

## 1. Clone and install

```sh
git clone https://github.com/abhijeethrkgadwal/averri.git
cd averri
npm install                 # Node 20+; installs every workspace package and links @averri/*
npm run typecheck           # tsc over all packages, the seed app and its generated tests
npm test                    # vitest workspace: packages + examples/seed-app (about 5 minutes)
```

**Not run here:** `git clone` and `npm install` (this pass worked in an existing checkout whose
dependencies were already installed and was not allowed to reinstall). `npm run typecheck` and
`npm test` were run.

## 2. The seed app

`examples/seed-app` is a multi-tenant Hono + Prisma + Zod backend with Averri declarations in
`src/averri/` (observe mode: nothing in the request path).

```sh
npx prisma generate --schema examples/seed-app/prisma/schema.prisma
cd examples/seed-app
npm run db:push             # SQLite file prisma/dev.db from the schema
npm run db:seed             # deterministic users, orgs, tokens (printed)
npm start                   # http://localhost:3000 (PORT to change)
curl -H "authorization: Bearer usr_seed_owner" localhost:3000/orgs
npm test                    # hand-written tests + Averri's generated tests (tests/averri)
cd ../..
```

On Windows, `prisma generate` fails with `EPERM ... rename query_engine-windows.dll.node` while any
process (a running test suite, `npm start`) holds the engine; stop it and re-run.

Run the CLI against it from the repository root (`npm run averri --` is `tsx --conditions=development packages/cli/src/bin.ts`; the `development` export condition makes workspace packages resolve to their TypeScript sources):

```sh
npm run averri -- --root examples/seed-app build      # graph, diagnostics, generated tests
npm run averri -- --root examples/seed-app overview   # stack, counts, health
npm run averri -- --root examples/seed-app find invite
npm run averri -- --root examples/seed-app inspect Action:Org.inviteMember
npm run averri -- --root examples/seed-app impact Entity:Membership
npm run averri -- --root examples/seed-app check --scope all   # build + tsc + every test (about 1-3 minutes)
npm run averri -- --root examples/seed-app docs       # SPEC.md cards + .averri/openapi.json
npm run averri -- --root examples/seed-app testgen    # regenerate tests/averri/*.gen.test.ts
```

Add `--json` to any command for the same JSON an MCP client receives. What you should see on the
seed app today: 11 entities, 38 routes (22 of them deliberately undeclared, reported as A2104
warnings), 12 actions, 4 queries, 6 policies, 8 events, 1 workflow, 1 integration, 0 errors, and a
green `check` (about 380 tests: 116 hand-written, the rest generated, 17 `it.todo` for clauses Averri
cannot derive fixtures for).

## 3. Your own Prisma + Hono (or Express) repo

Static analysis (`build`, `check` diagnostics, `overview`, `find`, `inspect`, `impact`, `suggest`,
`docs`, the MCP server) works on any repo from the checkout, without installing anything into it:

```sh
cd /path/to/your-repo
node $AVERRI/node_modules/tsx/dist/cli.mjs $AVERRI/packages/cli/src/bin.ts --root . init
node $AVERRI/node_modules/tsx/dist/cli.mjs $AVERRI/packages/cli/src/bin.ts --root . build
node $AVERRI/node_modules/tsx/dist/cli.mjs $AVERRI/packages/cli/src/bin.ts --root . suggest
```

(Writing `alias averri="node $AVERRI/node_modules/tsx/dist/cli.mjs $AVERRI/packages/cli/src/bin.ts"`
shortens these to `averri --root . build`.)

`init` writes `averri.config.ts`, a 40-line agent block into `CLAUDE.md`, `AGENTS.md` and
`.cursor/rules/averri.mdc`, and adds `@averri/core`, `@averri/contracts`, `fast-check` and `vitest` to
your `package.json` (it never runs an install). `build` then reports every route without a
declaration (A2104) or without auth middleware (A2103); `suggest` drafts observe-mode declarations
as a diff for you to review. Edit `averri.config.ts`: list your auth middleware names, one actor
fixture per role (with the headers your app authenticates), and `emitter` if you publish events.

This was run against a fresh two-model Prisma + Hono project in a temp directory: `init`, `build`
(entities, fields and routes extracted; A2103/A2104 reported), `suggest`, and after adding a
`members.averri.ts` with a policy, a query and an action, `build` bound both routes and generated two
test files.

**Not run here:** running the generated tests inside a repo outside this monorepo. They import
`@averri/contracts` and `@averri/core`, which are unpublished and ship TypeScript sources; until the
packages are on npm, link them from the checkout (`npm install $AVERRI/packages/core
$AVERRI/packages/contracts $AVERRI/packages/ir`) and give the entry module a `default` (or `app`) export
of the app, as `examples/seed-app/src/app.ts` does. `examples/seed-app/test/setup-averri.ts` shows
the per-file database setup the generated tests expect.

## 4. Connect your coding agent (MCP)

The server speaks MCP over stdio. Register it with the absolute paths of your checkout and project.

Claude Code:

```sh
claude mcp add averri -- node $AVERRI/node_modules/tsx/dist/cli.mjs $AVERRI/packages/cli/src/bin.ts --root /path/to/your-repo mcp
```

`.mcp.json` (Claude Code, project scope) or `.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "averri": {
      "command": "node",
      "args": ["/abs/averri/node_modules/tsx/dist/cli.mjs", "/abs/averri/packages/cli/src/bin.ts", "--root", "/abs/your-repo", "mcp"]
    }
  }
}
```

HTTP instead of stdio: `... bin.ts --root /path/to/your-repo mcp --http 3333` serves
`POST http://127.0.0.1:3333/mcp`.

Verified here: that exact stdio command, started by the MCP SDK client, listed the eight tools
(`overview, find, inspect, impact, check, explain, read_source, suggest`) and answered `find` for
the temp project; `packages/mcp/test/seed-app.e2e.test.ts` starts the same server against the seed
app and calls every tool, `check` included. **Not run here:** `claude mcp add` itself and Cursor's
UI (both edit your user configuration). The snippet `init` prints is `npx -y @averri/cli mcp`, which works from the npm package once it is
published (see docs/RELEASING.md for the pack-and-install check that proves it from tarballs).

## 5. What to expect

- Diagnostics are real: on the seed app the compiler found a GET handler that wrote to the database
  (A4004), a postcondition naming a field the response does not have (A3002), and declared effects
  that did not match the handler (A4002); all were fixed in the app or its declarations.
- Generated tests are derived from your declarations and run against your real app through
  `observe()`. They find places where a declaration is weaker than the code (a policy that ignores
  the actor type, a schema that accepts a cursor the app rejects). Expect to tighten declarations
  the first time you run them.
- See the README's Status section for what does not work yet.
