/**
 * Emitted machinery per Action/Query: the valid-input arbitrary, per-clause violating arbitraries,
 * predicate/policy/subject seed functions, `allowedFixture_<p>` and `invokeAllowed_<p>`.
 * Suites only call these names; everything about HOW a valid accepted call is made lives here.
 */

import { collectDbPredicates, exprEquals, isLit, isRef, refRoot, refSegments, type BoolExpr, type ContractId, type ContractNode } from "@averri/ir";
import { mergeConjunction, type FieldConstraint } from "./constraints.js";
import { ident, str } from "./emit.js";
import { planPredicateSeed, planSubjectSeed, type SeedFunction } from "./fixtures.js";
import { inputArbitrary, satisfyAll, violateOne, type ActionModel, type Ctx } from "./model.js";

export type Readiness = { ok: true } | { ok: false; reasons: string[] };

export interface ClauseSeed {
  contract: ContractNode;
  /** Wrapper `seed_<p>_<clause>(h, env, mode)`; null with `reason` when any predicate could not be planned. */
  name: string | null;
  reason: string | null;
  /** Why the clause's violation cannot be produced by falsifying its predicates (null = it can). */
  violationReason?: string | null;
  /** The clause is `db.exists` of the subject row itself: violating it means not seeding the subject. */
  coversSubject?: boolean;
}

/**
 * Emitted condition for the actor-only comparisons of a policy disjunct (`e.eq("actor.type", "user")`
 * conjuncts), or null when it has none. Seeding a disjunct the fixture's actor can never satisfy only
 * leaves junk rows behind (a membership whose userId is an API key id).
 */
function actorGuard(d: BoolExpr): string | null {
  const conjuncts = d.op === "and" ? d.args : [d];
  const conds: string[] = [];
  for (const c of conjuncts) {
    if ((c.op !== "eq" && c.op !== "ne") || !isRef(c.lhs) || !isLit(c.rhs) || Array.isArray(c.rhs.lit)) continue;
    const segs = refSegments(c.lhs.ref);
    if (refRoot(c.lhs.ref) !== "actor" || segs.length !== 1) continue;
    conds.push(`env.actor?.[${str(segs[0] as string)}] ${c.op === "eq" ? "===" : "!=="} ${JSON.stringify(c.rhs.lit)}`);
  }
  return conds.length > 0 ? conds.join(" && ") : null;
}

/** True for `db.*` predicates and `and`s of them: falsifying one predicate falsifies the clause. */
function isPredicateConjunction(expr: BoolExpr): boolean {
  if (expr.op === "db.exists" || expr.op === "db.none" || expr.op === "db.unique") return true;
  if (expr.op === "and") return expr.args.every(isPredicateConjunction);
  return false;
}

export interface ViolationArb {
  contract: ContractNode;
  /** `input_violate_<p>_<clause>` or null with `reason`. */
  varName: string | null;
  /** Subject seed variant to use for this violation (null = the satisfying subject seed or none). */
  subjectSeed: string | null;
  reason: string | null;
}

export interface ActionCode {
  model: ActionModel;
  code: string;
  validInput: string;
  validInputReason: string | null;
  ready: Readiness;
  seedPolicy: string | null;
  seedPolicyReason: string | null;
  seedRequires: string;
  seedSubject: string | null;
  seedSubjectReason: string | null;
  allowedFixture: string;
  invokeAllowed: string;
  clauseSeeds: ClauseSeed[];
  violations: ViolationArb[];
}

function selfConstraints(conj: ReturnType<typeof satisfyAll>): FieldConstraint[] | null {
  if (!conj.ok) return null;
  const merged = mergeConjunction(conj.conj.filter((a) => a.root === "self"));
  return merged.ok ? merged.fields : null;
}

export function emitActionCode(ctx: Ctx, m: ActionModel): ActionCode {
  const p = m.prefix;
  const parts: string[] = [];
  const reasons: string[] = [];
  const ownerLit = str(m.owner);

  // valid input
  const all = satisfyAll(m);
  const validInput = `input_valid_${p}`;
  let validInputReason: string | null = null;
  let validSrc = all.ok ? inputArbitrary(m, all.conj) : inputArbitrary(m, null);
  if (!all.ok) reasons.push(...all.reasons);
  if (!validSrc.ok) {
    validInputReason = validSrc.reason;
    reasons.push(`valid input: ${validSrc.reason}`);
    validSrc = { ok: true, src: "fc.constant({})" };
  }
  parts.push(`const ${validInput} = ${validSrc.src};`);

  // policy seeds (predicate policies only)
  let seedPolicy: string | null = null;
  let seedPolicyReason: string | null = null;
  if (m.policyContract?.tier === "predicate" && m.policyContract.expr) {
    // A top-level `or` is seeded per disjunct (D-40): satisfying one disjunct is enough (disjuncts are
    // seeded in order until the declared policy allows the fixture); falsifying needs every disjunct false.
    const expr = m.policyContract.expr;
    const disjuncts = expr.op === "or" ? expr.args : [expr];
    const groups: SeedFunction[][] = [];
    const guards: Array<string | null> = [];
    let k = 0;
    for (const d of disjuncts) {
      const fns: SeedFunction[] = [];
      for (const pred of collectDbPredicates(d)) {
        const r = planPredicateSeed(ctx.facts, `seed_${p}_policy_${k++}`, pred.op, pred.model, pred.where);
        if (!r.ok) {
          seedPolicyReason = `${m.policyContract.id}: ${r.reason}`;
          break;
        }
        fns.push(r.fn);
      }
      if (seedPolicyReason !== null) break;
      if (fns.length > 0) {
        groups.push(fns);
        guards.push(actorGuard(d));
      }
    }
    if (seedPolicyReason === null) {
      seedPolicy = `seedPolicy_${p}`;
      const call = (fns: SeedFunction[], mode: string, pad: string): string[] =>
        fns.map((f, i) => `${pad}await ${f.name}(h, env, ${i === 0 ? mode : '"satisfy"'});`);
      const allowed = `["allow", "public", "opaque"].includes(await h.policyDecision(${str(m.owner)}, fixture, env.input))`;
      const body =
        groups.length <= 1
          ? call(groups[0] ?? [], "mode", "  ")
          : [
              '  if (mode === "falsify") {',
              ...groups.flatMap((g) => call(g, '"falsify"', "    ")),
              "    return;",
              "  }",
              // a disjunct whose actor condition (`actor.type == "user"`) fails for this fixture is not seeded
              ...groups.flatMap((g, i) => {
                const seeds = [...call(g, '"satisfy"', "    "), ...(i < groups.length - 1 ? [`    if (${allowed}) return;`] : [])];
                return guards[i] ? [`  if (${guards[i]}) {`, ...seeds, "  }"] : seeds.map((l) => l.slice(2));
              }),
            ];
      parts.push(...groups.flat().map((f) => f.code));
      parts.push(
        [
          `async function ${seedPolicy}(h: AverriTestHarness, env: Env, mode: SeedMode, fixture: string): Promise<void> {`,
          ...body,
          "  void fixture;",
          "}",
        ].join("\n"),
      );
    } else {
      reasons.push(`policy fixtures: ${seedPolicyReason}`);
    }
  }

  // requires predicate seeds
  const clauseSeeds: ClauseSeed[] = [];
  for (const c of m.requires) {
    if (c.tier !== "predicate" || !c.expr) continue;
    const clauseName = ident(c.clause);
    const preds = collectDbPredicates(c.expr);
    const fns: SeedFunction[] = [];
    let reason: string | null = preds.length === 0 ? "no db predicate found" : null;
    for (const [i, pred] of preds.entries()) {
      const r = planPredicateSeed(ctx.facts, `seed_${p}_${clauseName}_${i}`, pred.op, pred.model, pred.where);
      if (!r.ok) {
        reason = r.reason;
        break;
      }
      fns.push(r.fn);
    }
    if (reason !== null) {
      clauseSeeds.push({ contract: c, name: null, reason });
      reasons.push(`${c.id}: ${reason}`);
      continue;
    }
    const name = `seed_${p}_${clauseName}`;
    const violationReason = isPredicateConjunction(c.expr)
      ? null
      : "the clause combines db predicates with other conditions under or/not; falsifying its predicates does not violate it";
    const coversSubject =
      c.expr.op === "db.exists" && m.subjectEntity !== null && m.subjectWhere !== null && c.expr.model === m.subjectEntity.clientName && exprEquals(c.expr.where, m.subjectWhere);
    parts.push(...fns.map((f) => f.code));
    parts.push(
      [
        `async function ${name}(h: AverriTestHarness, env: Env, mode: SeedMode): Promise<void> {`,
        ...fns.map((f, i) => `  await ${f.name}(h, env, ${i === 0 ? "mode" : '"satisfy"'});`),
        "}",
      ].join("\n"),
    );
    clauseSeeds.push({ contract: c, name, reason: null, violationReason, coversSubject });
  }
  const seedRequires = `seedRequires_${p}`;
  parts.push(
    [
      `async function ${seedRequires}(h: AverriTestHarness, env: Env): Promise<void> {`,
      ...clauseSeeds.filter((s) => s.name !== null).map((s) => `  await ${s.name}(h, env, "satisfy");`),
      "  void h; void env;",
      "}",
    ].join("\n"),
  );

  // subject seeds
  let seedSubject: string | null = null;
  let seedSubjectReason: string | null = null;
  if (m.subjectEntity && m.subjectWhere) {
    const constraints = selfConstraints(all);
    const r = planSubjectSeed(ctx.facts, `seedSubject_${p}`, m.subjectEntity, m.subjectWhere, constraints ?? []);
    if (r.ok) {
      seedSubject = r.fn.name;
      parts.push(r.fn.code);
    } else {
      seedSubjectReason = r.reason;
      reasons.push(`subject fixture: ${r.reason}`);
    }
  }

  // violating inputs per tier-1 requires clause
  const violations: ViolationArb[] = [];
  for (const c of m.requires) {
    if (c.tier !== "expr") continue;
    const v = violateOne(m, c);
    if (!v.ok) {
      violations.push({ contract: c, varName: null, subjectSeed: null, reason: v.reason });
      continue;
    }
    const arb = inputArbitrary(m, v.conj);
    if (!arb.ok) {
      violations.push({ contract: c, varName: null, subjectSeed: null, reason: arb.reason });
      continue;
    }
    const varName = `input_violate_${p}_${ident(c.clause)}`;
    parts.push(`const ${varName} = ${arb.src};`);
    let subjectSeedName: string | null = seedSubject;
    const selfAtoms = v.conj.filter((a) => a.root === "self");
    if (selfAtoms.length > 0) {
      if (!m.subjectEntity || !m.subjectWhere) {
        violations.push({ contract: c, varName: null, subjectSeed: null, reason: "clause references self.* but the action has no subject" });
        continue;
      }
      const merged = mergeConjunction(selfAtoms);
      if (!merged.ok) {
        violations.push({ contract: c, varName: null, subjectSeed: null, reason: merged.reason });
        continue;
      }
      const r = planSubjectSeed(ctx.facts, `seedSubject_${p}_violate_${ident(c.clause)}`, m.subjectEntity, m.subjectWhere, merged.fields);
      if (!r.ok) {
        violations.push({ contract: c, varName: null, subjectSeed: null, reason: r.reason });
        continue;
      }
      parts.push(r.fn.code);
      subjectSeedName = r.fn.name;
    }
    violations.push({ contract: c, varName, subjectSeed: subjectSeedName, reason: null });
  }

  // allowedFixture + invokeAllowed
  const allowedFixture = `allowedFixture_${p}`;
  const policyLabel = m.policy ? m.policy.id : "the declaration";
  if (m.node.public) {
    parts.push(
      [
        `async function ${allowedFixture}(h: AverriTestHarness, input: Record<string, unknown>): Promise<string> {`,
        "  void h; void input;",
        '  return "anonymous"; // public declaration',
        "}",
      ].join("\n"),
    );
  } else {
    parts.push(
      [
        `async function ${allowedFixture}(h: AverriTestHarness, input: Record<string, unknown>): Promise<string> {`,
        "  for (const fixture of FIXTURES) {",
        '    if (fixture === "anonymous") continue;',
        "    const env: Env = { input, actor: h.actor(fixture) };",
        seedPolicy ? `    await ${seedPolicy}(h, env, "satisfy", fixture);` : "    void env;",
        `    const decision = await h.policyDecision(${ownerLit}, fixture, input);`,
        '    if (decision === "allow" || decision === "public" || decision === "opaque") return fixture;',
        "  }",
        `  throw new Error(${str(`no actor fixture in FIXTURES is allowed by ${policyLabel} for this input; add a fixture to config.actors or seed the rows the policy needs`)});`,
        "}",
      ].join("\n"),
    );
  }
  const invokeAllowed = `invokeAllowed_${p}`;
  parts.push(
    [
      `async function ${invokeAllowed}(h: AverriTestHarness, input: Record<string, unknown>, options?: { headers?: Record<string, string> }): Promise<{ res: Invoked; fixture: string; env: Env }> {`,
      `  const fixture = await ${allowedFixture}(h, input);`,
      "  const env: Env = { input, actor: h.actor(fixture) };",
      `  await ${seedRequires}(h, env);`,
      seedSubject ? `  await ${seedSubject}(h, env);` : null,
      `  const res = await h.invoke(${ownerLit}, fixture, input, options);`,
      "  return { res, fixture, env };",
      "}",
    ]
      .filter((l): l is string => l !== null)
      .join("\n"),
  );
  parts.push(`void ${validInput}; void ${invokeAllowed};`);

  const ready: Readiness = reasons.length === 0 ? { ok: true } : { ok: false, reasons };
  return {
    model: m,
    code: parts.join("\n\n"),
    validInput,
    validInputReason,
    ready,
    seedPolicy,
    seedPolicyReason,
    seedRequires,
    seedSubject,
    seedSubjectReason,
    allowedFixture,
    invokeAllowed,
    clauseSeeds,
    violations,
  };
}

export function contractIdOf(c: ContractNode): ContractId {
  return c.id as ContractId;
}
