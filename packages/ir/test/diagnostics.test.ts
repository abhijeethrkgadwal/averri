import { describe, expect, it } from "vitest";

import {
  ALL_DIAGNOSTIC_CODES,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_FAMILIES,
  RESERVED_DIAGNOSTIC_CODES,
  codesOfFamily,
  compareDiagnostics,
  compareSeverity,
  countBySeverity,
  diagnosticConsistencyIssues,
  diagnosticFamily,
  diagnosticInfo,
  formatDiagnosticId,
  hasDeterministicFix,
  isDiagnosticCode,
  isReservedDiagnosticCode,
  isSeverityAllowed,
  lookupDiagnosticCode,
  maxSeverity,
  parseDiagnosticId,
  type DiagnosticCode,
} from "../src/index.js";
import { diagnostic } from "./fixtures.js";

describe("registry lookup", () => {
  it("every registered code is self-consistent", () => {
    expect(ALL_DIAGNOSTIC_CODES.length).toBe(31);
    for (const code of ALL_DIAGNOSTIC_CODES) {
      const info = diagnosticInfo(code);
      expect(info.code).toBe(code);
      expect(isDiagnosticCode(code)).toBe(true);
      expect(lookupDiagnosticCode(code)).toBe(DIAGNOSTIC_CODES[code]);
      expect(diagnosticFamily(code)).not.toBeNull();
      expect(info.title.length).toBeLessThanOrEqual(80);
      expect(isReservedDiagnosticCode(code)).toBe(false);
    }
  });
  it("unknown and reserved codes", () => {
    expect(isDiagnosticCode("A2102")).toBe(false);
    expect(isDiagnosticCode("A2107")).toBe(false);
    expect(isReservedDiagnosticCode("A2102")).toBe(true);
    expect(RESERVED_DIAGNOSTIC_CODES).toEqual(["A2102", "A2107"]);
    expect(lookupDiagnosticCode("A0000")).toBeNull();
    expect(lookupDiagnosticCode("toString")).toBeNull();
    expect(isDiagnosticCode("constructor")).toBe(false);
    expect(() => diagnosticInfo("A0000" as DiagnosticCode)).toThrow(/unknown diagnostic code/);
  });
  it("deterministic-fix flag matches SPEC-DIAGNOSTICS §2", () => {
    const withFix = ALL_DIAGNOSTIC_CODES.filter(hasDeterministicFix);
    expect(withFix).toEqual(["A2101", "A2103", "A3002", "A3006", "A3007", "A3010", "A4001", "A4002", "A6001"]);
    expect(hasDeterministicFix("A9001")).toBe(false);
  });
  it("families", () => {
    expect(diagnosticFamily("A1001")).toEqual({ family: "S1", name: DIAGNOSTIC_FAMILIES.S1 });
    expect(diagnosticFamily("A2107")).toEqual({ family: "S2", name: DIAGNOSTIC_FAMILIES.S2 });
    expect(diagnosticFamily("A9002")?.family).toBe("S9");
    expect(diagnosticFamily("A8001")).toBeNull();
    expect(diagnosticFamily("B1001")).toBeNull();
    expect(codesOfFamily("S5")).toEqual(["A5001", "A5002"]);
    expect(codesOfFamily("S9")).toEqual(["A9001", "A9002"]);
    expect(codesOfFamily("S1")).toHaveLength(5);
  });
});

describe("severity rules", () => {
  it("registry severity is a maximum", () => {
    expect(maxSeverity("A2103")).toBe("error");
    expect(isSeverityAllowed("A2103", "warning")).toBe(true);
    expect(isSeverityAllowed("A2103", "error")).toBe(true);
    expect(isSeverityAllowed("A4003", "error")).toBe(false);
    expect(isSeverityAllowed("A7001", "warning")).toBe(false);
    expect(compareSeverity("error", "info")).toBeLessThan(0);
    expect(compareSeverity("warning", "warning")).toBe(0);
  });
  it("compareDiagnostics orders by severity then path then id", () => {
    const list = [
      diagnostic("D-0003", "A7001", "info", { path: "a.ts:1" }),
      diagnostic("D-0002", "A1001", "error", { path: "z.ts:1" }),
      diagnostic("D-0001", "A1001", "error", { path: "b.ts:9" }),
      diagnostic("D-0004", "A1001", "error", { path: "b.ts:9" }),
      diagnostic("D-0005", "A4003", "warning"),
    ];
    expect(list.sort(compareDiagnostics).map((d) => d.id)).toEqual(["D-0001", "D-0004", "D-0002", "D-0005", "D-0003"]);
  });
  it("countBySeverity", () => {
    expect(countBySeverity([diagnostic("D-0001", "A1001", "error"), diagnostic("D-0002", "A4003", "warning"), diagnostic("D-0003", "A4003", "warning")])).toEqual({ error: 1, warning: 2, info: 0 });
  });
});

describe("ids and consistency", () => {
  it("formatDiagnosticId / parseDiagnosticId", () => {
    expect(formatDiagnosticId(1)).toBe("D-0001");
    expect(formatDiagnosticId(12345)).toBe("D-12345");
    expect(() => formatDiagnosticId(0)).toThrow(RangeError);
    expect(() => formatDiagnosticId(1.5)).toThrow(RangeError);
    expect(parseDiagnosticId("D-0042")).toBe(42);
    expect(parseDiagnosticId("D-42")).toBeNull();
    expect(parseDiagnosticId("x")).toBeNull();
  });
  it("diagnosticConsistencyIssues", () => {
    expect(diagnosticConsistencyIssues(diagnostic("D-0001", "A2101", "error", { docs: "averri://docs/action", fixes: [{ label: "l", evidence: "e", command: "c" }] }))).toEqual([]);
    const bad = diagnostic("D-0001", "A1001", "error", {
      docs: "averri://docs/graph",
      fixes: [{ label: "l", evidence: "e", command: "c" }],
      title: "x".repeat(81),
      related: ["Entity:A", "Entity:B", "Entity:C", "Entity:D", "Entity:E", "Entity:F"],
      cause: Array.from({ length: 5 }, (_, i) => ({ node: `Entity:${i}` as const, why: "w" })),
    });
    const issues = diagnosticConsistencyIssues(bad);
    expect(issues).toHaveLength(5);
    expect(issues[0]).toMatch(/deterministicFix: false but carries 1 fix/);
    expect(issues[1]).toMatch(/docs/);
    expect(diagnosticConsistencyIssues(diagnostic("D-0001", "A4003", "error"))).toEqual(['A4003 severity "error" is above the registry maximum "warning"']);
    expect(diagnosticConsistencyIssues({ ...diagnostic("D-0001", "A4003", "warning"), code: "A0000" as DiagnosticCode })).toEqual(['code "A0000" is not registered']);
  });
});
