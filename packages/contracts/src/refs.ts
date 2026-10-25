/**
 * Reference resolution over an {@link EvalEnv} (SPEC-CONTRACTS §2). Total: a missing root, a missing
 * field or a non-object on the way yields `undefined`.
 */
import type { DbWhereOperand, RefPath } from "@averri/ir";
import type { EvalEnv, Row } from "./types.js";
import { lengthOf } from "./values.js";

export function rootValue(root: string, env: EvalEnv): unknown {
  switch (root) {
    case "input":
      return env.input;
    case "actor":
      return env.actor;
    case "self":
      return env.self;
    case "old":
      return env.old;
    case "result":
      return env.result;
    default:
      return undefined;
  }
}

/** Resolves `<root>.<a>.<b>` against the env. Never throws. */
export function resolveRef(ref: RefPath | string, env: EvalEnv): unknown {
  const segments = ref.split(".");
  let current = rootValue(segments[0] ?? "", env);
  for (let i = 1; i < segments.length; i++) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Row)[segments[i] as string];
  }
  return current;
}

/**
 * Evaluates a `where` operator operand (ref, literal or `len`) to a scalar BEFORE the Prisma call.
 * `undefinedRef` names the ref when the operand resolved to `undefined`.
 */
export function evalWhereOperand(operand: DbWhereOperand, env: EvalEnv): { value: unknown; undefinedRef: RefPath | null } {
  if ("lit" in operand) return { value: operand.lit, undefinedRef: null };
  if ("ref" in operand) {
    const value = resolveRef(operand.ref, env);
    return { value, undefinedRef: value === undefined ? operand.ref : null };
  }
  const base = resolveRef(operand.arg.ref, env);
  const value = lengthOf(base);
  return { value, undefinedRef: value === undefined ? operand.arg.ref : null };
}
