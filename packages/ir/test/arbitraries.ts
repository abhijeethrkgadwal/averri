/** fast-check arbitraries for contract ASTs and small graphs. */

import fc from "fast-check";

import type { BoolExpr, DbWhere, DbWhereOperand, DbWhereValue, Lit, Operand, Ref } from "../src/index.js";

const ident = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,5}$/);
const root = fc.constantFrom("input", "result", "actor", "self", "old");

export const refArb = (): fc.Arbitrary<Ref> =>
  fc.tuple(root, fc.array(ident, { minLength: 1, maxLength: 3 })).map(([r, segs]) => ({ ref: `${r}.${segs.join(".")}` as Ref["ref"] }));

const scalar = fc.oneof(fc.string({ maxLength: 6 }), fc.integer({ min: -50, max: 50 }), fc.boolean(), fc.constant(null));

export const litArb = (): fc.Arbitrary<Lit> => fc.oneof(scalar.map((lit) => ({ lit })), fc.array(scalar, { maxLength: 4 }).map((lit) => ({ lit })));

export const whereValueArb = (): fc.Arbitrary<DbWhereValue> =>
  fc.oneof(
    refArb(),
    litArb(),
    fc.record({ in: fc.oneof(litArb(), refArb()) }),
    fc.record({ not: fc.oneof(refArb(), litArb()) }),
    fc.record({ lt: fc.oneof<fc.Arbitrary<DbWhereOperand>[]>(refArb(), litArb(), refArb().map((arg) => ({ op: "len" as const, arg }))) }),
    fc.record({ gte: fc.oneof(refArb(), litArb()) }),
  );

export const whereArb = (): fc.Arbitrary<DbWhere> => fc.dictionary(ident, whereValueArb(), { maxKeys: 3 });

export const operandArb = (): fc.Arbitrary<Operand> =>
  fc.oneof(
    { depthSize: "small" },
    refArb(),
    litArb(),
    refArb().map((arg) => ({ op: "len" as const, arg })),
    fc.tuple(refArb(), ident).map(([path, field]) => ({ op: "sum" as const, path, field })),
    fc.tuple(ident, whereArb()).map(([model, where]) => ({ op: "db.countWhere" as const, model, where })),
  );

export const boolExprArb = (): fc.Arbitrary<BoolExpr> =>
  fc.letrec<{ expr: BoolExpr }>((tie) => ({
    expr: fc.oneof(
      { depthSize: "small", maxDepth: 4 },
      fc.tuple(fc.constantFrom("eq", "ne", "lt", "lte", "gt", "gte"), operandArb(), operandArb()).map(([op, lhs, rhs]) => ({ op, lhs, rhs }) as BoolExpr),
      fc.tuple(fc.constantFrom("and", "or"), fc.array(tie("expr"), { minLength: 1, maxLength: 3 })).map(([op, args]) => ({ op, args }) as BoolExpr),
      tie("expr").map((arg) => ({ op: "not" as const, arg })),
      fc.tuple(operandArb(), fc.oneof(litArb(), refArb())).map(([lhs, rhs]) => ({ op: "in" as const, lhs, rhs })),
      refArb().map((arg) => ({ op: "isNull" as const, arg })),
      fc.tuple(refArb(), fc.option(tie("expr"), { nil: undefined })).map(([path, where]) => (where ? { op: "exists" as const, path, where } : { op: "exists" as const, path })),
      fc.tuple(ident, fc.option(fc.nat(3), { nil: undefined })).map(([e, count]) => (count === undefined ? { op: "emitted" as const, event: `Event:${e}` as const } : { op: "emitted" as const, event: `Event:${e}` as const, count })),
      fc.tuple(fc.constantFrom("db.exists", "db.none", "db.unique"), ident, whereArb()).map(([op, model, where]) => ({ op, model, where }) as BoolExpr),
    ),
  })).expr;
