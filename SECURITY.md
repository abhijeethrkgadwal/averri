# Security policy

Averri is pre-alpha. Do not run it against production data yet.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security tab, "Report a vulnerability"). Do not open a public issue
for anything that could be exploited.

You will get an acknowledgement within 7 days. Fixes for confirmed
issues are released as a patch version with a changelog entry that
credits the reporter unless they ask otherwise.

## Scope

In scope: the `@averri/*` packages, the `averri` CLI, and the MCP
server. Of particular interest:

- The compiler must never evaluate user code. Lowering is static
  (ts-morph). A way to make `averri build` execute code from the
  analysed repository is a vulnerability.
- Contract evaluation must fail closed. Any path where an undefined
  reference, thrown guard, or evaluator bug lets a `requires` or
  `policy` clause pass is a vulnerability.
- The MCP `read_source` tool must not read outside the project root.

Out of scope: the example seed app (deliberately simplified), and
anything in `docs/research/`.

## No telemetry

Averri sends nothing anywhere. There is no usage reporting, crash
reporting, or update check. If you find network activity that is not
an explicit user action (such as `npm install`), report it as a
vulnerability.
