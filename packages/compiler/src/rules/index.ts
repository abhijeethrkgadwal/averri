/**
 * The rule registry (SPEC-DIAGNOSTICS §2, §6). Lowering-time codes are emitted where the fact is
 * found: A1001 (duplicate ids), A1003 (unknown model), A1004 (non-analysable option), A3004 (path too
 * deep), A3009 for nested db values in a where, A4001 for `e.emitted(X)` with an undeclared X.
 * A6001 runs after the generated Test nodes are derived. A9001/A9002 belong to `check`.
 */

import type { Diagnostic } from "@averri/ir";
import { ruleA1002 } from "./A1002.js";
import { ruleA1005 } from "./A1005.js";
import { ruleA2101 } from "./A2101.js";
import { ruleA2103 } from "./A2103.js";
import { ruleA2104 } from "./A2104.js";
import { ruleA2105 } from "./A2105.js";
import { ruleA2106 } from "./A2106.js";
import { ruleA3001 } from "./A3001.js";
import { ruleA3002 } from "./A3002.js";
import { ruleA3003 } from "./A3003.js";
import { ruleA3005 } from "./A3005.js";
import { ruleA3006 } from "./A3006.js";
import { ruleA3007 } from "./A3007.js";
import { ruleA3008 } from "./A3008.js";
import { ruleA3009 } from "./A3009.js";
import { ruleA3010 } from "./A3010.js";
import { ruleA4001 } from "./A4001.js";
import { ruleA4002 } from "./A4002.js";
import { ruleA4003 } from "./A4003.js";
import { ruleA4004 } from "./A4004.js";
import { ruleA4005 } from "./A4005.js";
import { ruleA5001 } from "./A5001.js";
import { ruleA5002 } from "./A5002.js";
import { ruleA7001 } from "./A7001.js";
import type { Rule, RuleContext } from "./context.js";

export const RULES: ReadonlyArray<readonly [string, Rule]> = [
  ["A1002", ruleA1002],
  ["A1005", ruleA1005],
  ["A2101", ruleA2101],
  ["A2103", ruleA2103],
  ["A2104", ruleA2104],
  ["A2105", ruleA2105],
  ["A2106", ruleA2106],
  ["A3001", ruleA3001],
  ["A3002", ruleA3002],
  ["A3003", ruleA3003],
  ["A3005", ruleA3005],
  ["A3006", ruleA3006],
  ["A3007", ruleA3007],
  ["A3008", ruleA3008],
  ["A3009", ruleA3009],
  ["A3010", ruleA3010],
  ["A4001", ruleA4001],
  ["A4002", ruleA4002],
  ["A4003", ruleA4003],
  ["A4004", ruleA4004],
  ["A4005", ruleA4005],
  ["A5001", ruleA5001],
  ["A5002", ruleA5002],
  ["A7001", ruleA7001],
];

/** Run every graph rule (A6001 excluded: it needs the derived Test nodes). */
export function runRules(ctx: RuleContext): Diagnostic[] {
  return RULES.flatMap(([, rule]) => rule(ctx));
}

export { ruleA6001, generatedFileReader, isStale } from "./A6001.js";
export * from "./context.js";
