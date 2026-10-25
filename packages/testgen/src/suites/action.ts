/**
 * Suites owned by an Action/Query: auth-matrix, precondition, postcondition, event, pitfall.idempotency.
 * Every `it` title starts with `[<TestId>]` and names the Contract/Policy it asserts so Vitest output
 * joins back to the graph (SPEC-CONTRACTS §9).
 */

import { generatedTestId, type NodeId, type TestId } from "@averri/ir";
import type { ActionCode } from "../action-code.js";
import { comment, indent, lines, str, todo } from "../emit.js";
import type { Ctx } from "../model.js";

export interface SuiteCode {
  id: TestId;
  code: string;
  covers: NodeId[];
  todos: string[];
}

function describeBlock(id: TestId, body: string[]): string {
  return [`describe(${str(`[${id}]`)}, () => {`, indent(lines(...body)), "});"].join("\n");
}

function notReady(code: ActionCode): string {
  return code.ready.ok ? "" : code.ready.reasons.join("; ");
}

// ---------------------------------------------------------------------------
// auth-matrix
// ---------------------------------------------------------------------------

export function authMatrixSuite(ctx: Ctx, code: ActionCode): SuiteCode | null {
  const m = code.model;
  if (!m.policy) return null;
  const id = generatedTestId(m.owner, "auth-matrix");
  const covers: NodeId[] = [m.owner, m.policy.id];
  const todos: string[] = [];
  const policyLit = str(m.policy.id);
  const ownerLit = str(m.owner);
  const title = (text: string) => `[${id}] [${m.policy?.id}] ${text}`;

  if (m.policy.tier === "guard" || !m.policyContract?.expr) {
    const reason = `${m.policy.id} is an opaque guard; the auth matrix is not derivable (A2106)`;
    todos.push(reason);
    return { id, covers, todos, code: describeBlock(id, [todo(title(reason))]) };
  }
  if (code.validInputReason) {
    const reason = `valid input is not derivable: ${code.validInputReason}`;
    todos.push(reason);
    return { id, covers, todos, code: describeBlock(id, [todo(title(reason))]) };
  }

  const declared = m.node.mode === "declared";
  const strictAllow = code.ready.ok && m.guards.length === 0;
  const expectAuth = declared
    ? [
        "function expectAuth(res: Invoked, expected: string): void {",
        '  if (expected === "unauthenticated") { expect(res.status, "anonymous actor").toBe(401); return; }',
        `  if (expected === "deny") { expect(res.status, "denied actor").toBe(403); expect(errorBody(res).contract).toBe(${policyLit}); return; }`,
        strictAllow
          ? '  expect(res.status >= 400 && res.status < 500, `allowed actor: expected a non-4xx status, got ${res.status} ${JSON.stringify(res.body)}`).toBe(false);'
          : "  // allowed: only the auth outcome is checked (a guard or a non-derivable precondition may still reject)\n  expect(res.status).not.toBe(401); expect(res.status).not.toBe(403);",
        "}",
      ]
    : [
        "function expectAuth(res: Invoked, expected: string): void {",
        "  // 404 counts as a denial: apps commonly answer \"not found\" for resources outside the actor's reach (D-40)",
        '  if (expected === "unauthenticated" || expected === "deny") { expect([401, 403, 404], `denied actor: got ${res.status}`).toContain(res.status); return; }',
        strictAllow
          ? '  expect2xx(res, "allowed actor");'
          : [
              "  // allowed: only the auth outcome is checked (a guard or a non-derivable precondition may still reject);",
              "  // a 403 the trace explains by a failed precondition is a business rejection, not an authorization one",
              '  if (res.status === 403 && (res.trace?.phases ?? []).some((p) => p.phase === "requires" && !p.ok)) return;',
              "  expect(res.status).not.toBe(401); expect(res.status).not.toBe(403);",
            ].join("\n"),
        "}",
      ];

  const seedAllowed = [`await ${code.seedRequires}(h, env);`, code.seedSubject ? `await ${code.seedSubject}(h, env);` : null].filter((l): l is string => l !== null);
  const body: string[] = [
    comment(
      declared
        ? "Declared mode: 401 for anonymous, 403 + Policy id on deny, non-4xx on allow (the pipeline evaluates the same AST: a wiring check)."
        : "Observe mode: the app's own 401/403 vs 2xx is compared with the declared policy evaluated against each fixture's actor.",
    ),
    ...expectAuth,
    "for (const fixture of FIXTURES) {",
    indent(
      lines(
        `it(\`${title("${fixture}: app decision matches the declared policy")}\`, async () => {`,
        indent(
          lines(
            `const input = drawInput(h, ${ownerLit}, ${code.validInput});`,
            "const env: Env = { input, actor: h.actor(fixture) };",
            code.seedPolicy ? `if (fixture !== "anonymous") await ${code.seedPolicy}(h, env, "satisfy", fixture);` : null,
            `const expected = await h.policyDecision(${ownerLit}, fixture, input);`,
            `if (expected === "allow" || expected === "public" || expected === "opaque") { ${seedAllowed.join(" ")} }`,
            `const res = await h.invoke(${ownerLit}, fixture, input);`,
            "expectAuth(res, expected);",
          ),
        ),
        "});",
      ),
    ),
    "}",
  ];
  if (m.policyContract.tier === "predicate") {
    if (code.seedPolicy) {
      body.push(
        "for (const fixture of FIXTURES) {",
        indent(
          lines(
            'if (fixture === "anonymous") continue;',
            `it(\`${title("${fixture}: with the policy predicate falsified the app denies")}\`, async () => {`,
            indent(
              lines(
                `const input = drawInput(h, ${ownerLit}, ${code.validInput});`,
                "const env: Env = { input, actor: h.actor(fixture) };",
                `await ${code.seedPolicy}(h, env, "falsify", fixture);`,
                `const expected = await h.policyDecision(${ownerLit}, fixture, input);`,
                `const res = await h.invoke(${ownerLit}, fixture, input);`,
                "expectAuth(res, expected);",
              ),
            ),
            "});",
          ),
        ),
        "}",
      );
    } else {
      const reason = `policy predicate fixtures are not derivable: ${code.seedPolicyReason ?? "unknown"}`;
      todos.push(reason);
      body.push(todo(title(reason)));
    }
  }
  return { id, covers, todos, code: describeBlock(id, body) };
}

// ---------------------------------------------------------------------------
// precondition
// ---------------------------------------------------------------------------

export function preconditionSuite(ctx: Ctx, code: ActionCode): SuiteCode | null {
  const m = code.model;
  if (m.node.kind !== "Action" || m.requires.length === 0) return null;
  const id = generatedTestId(m.owner, "precondition");
  const covers: NodeId[] = [m.owner, ...m.requires.map((c) => c.id as NodeId)];
  const todos: string[] = [];
  const ownerLit = str(m.owner);
  const declared = m.node.mode === "declared";
  const body: string[] = [
    comment(
      declared
        ? "Declared mode: a violation is 412 PreconditionFailed carrying the Contract id; satisfying input is not 412."
        : "Observe mode: a violation is a non-2xx response whose trace has `ok: false` for the contract; satisfying input is 2xx.",
    ),
  ];
  const rejection = (contractLit: string) =>
    declared
      ? [`expect(res.status, "violating input").toBe(412);`, `expect(errorBody(res).contract).toBe(${contractLit});`]
      : [`expect(is2xx(res.status), "violating input must not be accepted").toBe(false);`, `expect(phaseRecord(res.trace, "requires", ${contractLit})?.ok).toBe(false);`];

  for (const c of m.requires) {
    const contractLit = str(c.id);
    const title = `[${id}] [${c.id}] violation is rejected`;
    if (c.tier === "expr") {
      const v = code.violations.find((x) => x.contract.id === c.id);
      if (!v || v.varName === null) {
        const reason = `${title}: ${v?.reason ?? "not derivable"}`;
        todos.push(reason);
        body.push(todo(reason));
        continue;
      }
      body.push(
        `it(${str(title)}, async () => {`,
        indent(
          lines(
            `const input = drawInput(h, ${ownerLit}, ${v.varName});`,
            `const fixture = await ${code.allowedFixture}(h, input);`,
            "const env: Env = { input, actor: h.actor(fixture) };",
            `await ${code.seedRequires}(h, env);`,
            v.subjectSeed ? `await ${v.subjectSeed}(h, env);` : null,
            `const res = await h.invoke(${ownerLit}, fixture, input);`,
            ...rejection(contractLit),
          ),
        ),
        "});",
      );
    } else {
      const seed = code.clauseSeeds.find((s) => s.contract.id === c.id);
      if (!seed || seed.name === null || seed.violationReason) {
        const reason = `${title}: ${seed?.violationReason ?? seed?.reason ?? "not derivable"}`;
        todos.push(reason);
        body.push(todo(reason));
        continue;
      }
      body.push(
        `it(${str(title)}, async () => {`,
        indent(
          lines(
            `const input = drawInput(h, ${ownerLit}, ${code.validInput});`,
            `const fixture = await ${code.allowedFixture}(h, input);`,
            "const env: Env = { input, actor: h.actor(fixture) };",
            ...code.clauseSeeds.filter((s) => s.name !== null).map((s) => `await ${s.name}(h, env, ${s.contract.id === c.id ? '"falsify"' : '"satisfy"'});`),
            // a clause that asserts the subject row exists is violated by not seeding the subject
            code.seedSubject && !seed.coversSubject ? `await ${code.seedSubject}(h, env);` : null,
            `const res = await h.invoke(${ownerLit}, fixture, input);`,
            ...rejection(contractLit),
          ),
        ),
        "});",
      );
    }
  }
  const okTitle = `[${id}] all preconditions satisfied -> accepted`;
  if (code.ready.ok) {
    if (m.guards.length > 0) body.push(comment(`opaque guards (${m.guards.map((g) => g.clause).join(", ")}) get no fixture; they may still reject this call`));
    body.push(
      `it(${str(okTitle)}, async () => {`,
      indent(
        lines(
          `const input = drawInput(h, ${ownerLit}, ${code.validInput});`,
          `const { res } = await ${code.invokeAllowed}(h, input);`,
          declared ? 'expect(res.status, "satisfying input must not fail a precondition").not.toBe(412);' : 'expect2xx(res, "satisfying input");',
        ),
      ),
      "});",
    );
  } else {
    const reason = `${okTitle}: ${notReady(code)}`;
    todos.push(reason);
    body.push(todo(reason));
  }
  return { id, covers, todos, code: describeBlock(id, body) };
}

// ---------------------------------------------------------------------------
// postcondition
// ---------------------------------------------------------------------------

export function postconditionSuite(ctx: Ctx, code: ActionCode): SuiteCode | null {
  const m = code.model;
  if (m.ensures.length === 0) return null;
  const id = generatedTestId(m.owner, "postcondition");
  const covers: NodeId[] = [m.owner, ...m.ensures.map((c) => c.id as NodeId)];
  const todos: string[] = [];
  const ownerLit = str(m.owner);
  const declared = m.node.mode === "declared";
  const body: string[] = [
    comment(
      declared
        ? "Declared mode: the pipeline evaluates ensures on the 2xx result (500 PostconditionFailed otherwise); the trace is the evidence."
        : "Observe mode: the wrapper evaluates ensures over the parsed 2xx body; the trace is the evidence.",
    ),
  ];
  for (const c of m.ensures) {
    const contractLit = str(c.id);
    const title = `[${id}] [${c.id}] holds on every accepted result`;
    if (!code.ready.ok) {
      const reason = `${title}: ${notReady(code)}`;
      todos.push(reason);
      body.push(todo(reason));
      continue;
    }
    body.push(
      `it(${str(title)}, async () => {`,
      indent(
        lines(
          `await fc.assert(fc.asyncProperty(${code.validInput}, async (raw) => {`,
          indent(
            lines(
              `const conformed = h.conformInput(${ownerLit}, raw);`,
              "fc.pre(conformed !== null);",
              "const input = conformed as Record<string, unknown>;",
              `const { res } = await ${code.invokeAllowed}(h, input);`,
              declared ? `if (res.status === 500) expect(errorBody(res)).not.toMatchObject({ error: "PostconditionFailed", contract: ${contractLit} });` : null,
              "fc.pre(is2xx(res.status));",
              `expect(phaseRecord(res.trace, "ensures", ${contractLit})?.ok, ${str(`${c.id} must hold`)}).toBe(true);`,
            ),
          ),
          "}), { numRuns: NUM_RUNS });",
        ),
      ),
      "}, PROPERTY_TIMEOUT_MS);",
    );
  }
  return { id, covers, todos, code: describeBlock(id, body) };
}

// ---------------------------------------------------------------------------
// event
// ---------------------------------------------------------------------------

export function eventSuite(ctx: Ctx, code: ActionCode): SuiteCode | null {
  const m = code.model;
  if (m.emitted.length === 0) return null;
  const id = generatedTestId(m.owner, "event");
  const covers: NodeId[] = [m.owner, ...m.emitted.map((e) => e.contract.id as NodeId), ...m.emitted.map((e) => e.event as NodeId)];
  const todos: string[] = [];
  const ownerLit = str(m.owner);
  const declared = m.node.mode === "declared";
  const body: string[] = [comment(declared ? "Declared mode: buffered emissions recorded in the trace's emit phase." : "Observe mode: calls captured by the spy on config.emitter.spy.")];
  for (const e of m.emitted) {
    const eventLit = str(e.event);
    const expectation =
      typeof e.count === "number"
        ? { text: `exactly ${e.count}`, asserts: [`expect(count, ${str(`${e.event} emissions`)}).toBe(${e.count});`] }
        : e.count === undefined
          ? { text: "at least 1", asserts: [`expect(count, ${str(`${e.event} emissions`)}).toBeGreaterThanOrEqual(1);`] }
          : {
              text: `between ${e.count.min ?? 0} and ${e.count.max ?? "any"}`,
              asserts: [
                e.count.min !== undefined ? `expect(count, ${str(`${e.event} emissions`)}).toBeGreaterThanOrEqual(${e.count.min});` : null,
                e.count.max !== undefined ? `expect(count, ${str(`${e.event} emissions`)}).toBeLessThanOrEqual(${e.count.max});` : null,
              ].filter((l): l is string => l !== null),
            };
    const title = `[${id}] [${e.contract.id}] ${e.event} emitted ${expectation.text}`;
    if (!code.ready.ok) {
      const reason = `${title}: ${notReady(code)}`;
      todos.push(reason);
      body.push(todo(reason));
      continue;
    }
    body.push(
      `it(${str(title)}, async () => {`,
      indent(
        lines(
          `const input = drawInput(h, ${ownerLit}, ${code.validInput});`,
          `const { res } = await ${code.invokeAllowed}(h, input);`,
          `expect2xx(res, "accepted call");`,
          declared ? `const count = emittedCount(res.trace, ${eventLit});` : `const count = h.emitted().filter((x) => x.event === ${eventLit}).length;`,
          ...expectation.asserts,
        ),
      ),
      "});",
    );
  }
  return { id, covers, todos, code: describeBlock(id, body) };
}

// ---------------------------------------------------------------------------
// pitfall.idempotency (actions)
// ---------------------------------------------------------------------------

export function idempotencySuite(ctx: Ctx, code: ActionCode): SuiteCode | null {
  const m = code.model;
  if (m.node.kind !== "Action" || !m.node.idempotency) return null;
  const id = generatedTestId(m.owner, "pitfall.idempotency");
  const covers: NodeId[] = [m.owner];
  const todos: string[] = [];
  const title = `[${id}] duplicate delivery has a single effect`;
  const key = m.node.idempotency.key;
  const ownerLit = str(m.owner);
  const writes = m.writes.length > 0 ? m.writes : ctx.facts.entities().map((e) => e.clientName);
  const body: string[] = [
    comment(
      `Single effect = identical after-snapshots (findMany ordered by @id) of ${m.writes.length > 0 ? "every table in effects.verified.writes" : "every table (no verified writes recorded)"} after the first and the second delivery; the second response is not 5xx (D-11).`,
    ),
  ];
  if (!code.ready.ok) {
    const reason = `${title}: ${notReady(code)}`;
    todos.push(reason);
    body.push(todo(reason));
    return { id, covers, todos, code: describeBlock(id, body) };
  }
  const headers = "header" in key ? `{ ${str(key.header)}: \`averri-\${nonce()}\` }` : null;
  body.push(
    `const WRITES = [${writes.map((w) => str(w)).join(", ")}];`,
    `it(${str(title)}, async () => {`,
    indent(
      lines(
        `const input = drawInput(h, ${ownerLit}, ${code.validInput});`,
        headers ? `const options = { headers: ${headers} };` : `const options = undefined; // the key is input.${"input" in key ? key.input : ""}: the same input is delivered twice`,
        `const first = await ${code.invokeAllowed}(h, input, options);`,
        'expect2xx(first.res, "first delivery");',
        "const after1 = await h.snapshot(WRITES);",
        `const second = await h.invoke(${str(m.owner)}, first.fixture, input, options);`,
        'expect(second.status, "second delivery must not fail with 5xx").toBeLessThan(500);',
        "const after2 = await h.snapshot(WRITES);",
        'expect(after2, "second delivery must not change any written table").toEqual(after1);',
      ),
    ),
    "});",
  );
  return { id, covers, todos, code: describeBlock(id, body) };
}
