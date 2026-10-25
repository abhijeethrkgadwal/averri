import type { LitScalar } from "@averri/ir";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbitrarySource, isIsoDate, valueTypeOfField, valueTypeOfLiteral, valueTypeOfName } from "../src/arbitraries.js";
import { constrainedArbitrary } from "../src/model.js";
import { instantiate } from "./mini-eval.js";

describe("value types", () => {
  it("maps Prisma scalars and enums", () => {
    expect(valueTypeOfField({ kind: "scalar", name: "Int", list: false }, "n").kind).toBe("int");
    expect(valueTypeOfField({ kind: "scalar", name: "Decimal", list: false }, "n").kind).toBe("float");
    expect(valueTypeOfField({ kind: "scalar", name: "DateTime", list: false }, "n").kind).toBe("date");
    expect(valueTypeOfField({ kind: "scalar", name: "Json", list: false }, "n").kind).toBe("json");
    expect(valueTypeOfField({ kind: "enum", name: "Role", values: ["a"], list: false }, "n")).toMatchObject({ kind: "enum", values: ["a"] });
    expect(valueTypeOfField({ kind: "relation", to: "Entity:X", list: false }, "n").kind).toBe("unsupported");
    expect(valueTypeOfField({ kind: "unsupported", raw: "geo" }, "n").kind).toBe("unsupported");
  });
  it("infers from literals and names", () => {
    expect(valueTypeOfLiteral(1).kind).toBe("int");
    expect(valueTypeOfLiteral(1.5).kind).toBe("float");
    expect(valueTypeOfLiteral(true).kind).toBe("boolean");
    expect(valueTypeOfLiteral("2025-01-01T00:00:00Z").kind).toBe("date");
    expect(valueTypeOfLiteral("pending").kind).toBe("string");
    expect(valueTypeOfName("email").kind).toBe("string");
    expect(valueTypeOfName("createdAt").kind).toBe("date");
    expect(valueTypeOfName("isActive").kind).toBe("boolean");
    expect(valueTypeOfName("quantity").kind).toBe("int");
    expect(valueTypeOfName("teamId").kind).toBe("string");
    expect(isIsoDate("2025-13-01")).toBe(false);
  });
});

describe("arbitrarySource produces real fast-check arbitraries", () => {
  it("every supported kind samples values of the right shape (wire flavour)", () => {
    const string = instantiate<string>(arbitrarySource({ kind: "string", hint: "name" }, "wire")!);
    fc.assert(fc.property(string, (s) => /^[a-z0-9]{1,12}$/.test(s)));
    const email = instantiate<string>(arbitrarySource({ kind: "string", hint: "email" }, "wire")!);
    fc.assert(fc.property(email, (s) => s.includes("@")));
    const uniqueEmail = instantiate<string>(arbitrarySource({ kind: "string", hint: "email", unique: true }, "wire")!);
    expect(new Set(fc.sample(uniqueEmail, 20)).size).toBe(20);
    const int = instantiate<number>(arbitrarySource({ kind: "int" }, "wire", { min: 3, max: 7 })!);
    fc.assert(fc.property(int, (n) => Number.isInteger(n) && n >= 3 && n <= 7));
    const dbl = instantiate<number>(arbitrarySource({ kind: "float" }, "wire", { min: 0, max: 1 })!);
    fc.assert(fc.property(dbl, (n) => Number.isFinite(n) && n >= 0 && n <= 1));
    const big = instantiate<number>(arbitrarySource({ kind: "bigint" }, "wire")!);
    fc.assert(fc.property(big, (n) => typeof n === "number"));
    const bool = instantiate<boolean>(arbitrarySource({ kind: "boolean" }, "wire")!);
    fc.assert(fc.property(bool, (b) => typeof b === "boolean"));
    const date = instantiate<string>(arbitrarySource({ kind: "date" }, "wire")!);
    fc.assert(fc.property(date, (d) => isIsoDate(d) && Date.parse(d) >= Date.parse("2024-01-01") && Date.parse(d) <= Date.parse("2026-12-31")));
    const en = instantiate<string>(arbitrarySource({ kind: "enum", values: ["a", "b"] }, "wire")!);
    fc.assert(fc.property(en, (v) => v === "a" || v === "b"));
  });

  it("row flavour gives Date objects and bigints", () => {
    const date = instantiate<Date>(arbitrarySource({ kind: "date" }, "row")!);
    fc.assert(fc.property(date, (d) => d instanceof Date && !Number.isNaN(d.getTime())));
    const big = instantiate<bigint>(arbitrarySource({ kind: "bigint" }, "row")!);
    fc.assert(fc.property(big, (n) => typeof n === "bigint"));
    const uniqueInt = instantiate<number>(arbitrarySource({ kind: "int", unique: true }, "row")!);
    expect(new Set(fc.sample(uniqueInt, 20)).size).toBe(20);
  });

  it("returns null for json, bytes, unsupported and empty enums", () => {
    expect(arbitrarySource({ kind: "json" }, "wire")).toBeNull();
    expect(arbitrarySource({ kind: "bytes" }, "wire")).toBeNull();
    expect(arbitrarySource({ kind: "unsupported" }, "wire")).toBeNull();
    expect(arbitrarySource({ kind: "enum", values: [] }, "wire")).toBeNull();
  });
});

describe("constrainedArbitrary", () => {
  const base = { ne: [] as LitScalar[], notIn: [] as LitScalar[] };
  it("eq / in / isNull become constants", () => {
    expect(constrainedArbitrary({ kind: "string" }, { root: "input", field: "x", ...base, eq: "a" }, "wire")).toEqual({ ok: true, src: 'fc.constant("a")' });
    expect(constrainedArbitrary({ kind: "string" }, { root: "input", field: "x", ...base, isNull: true }, "wire")).toEqual({ ok: true, src: "fc.constant(null)" });
    const r = constrainedArbitrary({ kind: "string" }, { root: "input", field: "x", ne: ["b"], notIn: [], in: ["a", "b"] }, "wire");
    expect(r.ok && r.src).toBe('fc.constantFrom("a", "b").filter((v) => v !== "b")');
    const inst = instantiate<string>(r.ok ? r.src : "");
    fc.assert(fc.property(inst, (v) => v === "a"));
  });
  it("numeric bounds honour exclusivity and dates become ISO strings on the wire", () => {
    const r = constrainedArbitrary({ kind: "int" }, { root: "input", field: "n", ...base, min: { value: 3, exclusive: true }, max: { value: 5, exclusive: false } }, "wire");
    expect(r.ok && r.src).toBe("fc.integer({ min: 4, max: 5 })");
    const d = constrainedArbitrary({ kind: "date" }, { root: "input", field: "d", ...base, min: { value: "2025-01-01", exclusive: true } }, "wire");
    expect(d.ok && d.src).toContain("fc.date({ min: new Date(\"2025-01-01T00:00:00.001Z\")");
    const inst = instantiate<string>(d.ok ? d.src : "");
    fc.assert(fc.property(inst, (v) => Date.parse(v) > Date.parse("2025-01-01")));
    const rowDate = constrainedArbitrary({ kind: "date" }, { root: "self", field: "d", ...base, eq: "2025-01-01" }, "row");
    expect(rowDate.ok && rowDate.src).toBe('fc.constant(new Date("2025-01-01"))');
  });
  it("a numeric literal overrides a name-based string guess", () => {
    const r = constrainedArbitrary({ kind: "string", hint: "level" }, { root: "input", field: "level", ...base, min: { value: 1, exclusive: false } }, "wire");
    expect(r.ok && r.src).toBe("fc.integer({ min: 1, max: 1000000 })");
  });
  it("length ranges drop the unique nonce suffix", () => {
    const r = constrainedArbitrary({ kind: "string", unique: true, hint: "name" }, { root: "input", field: "name", ...base, lenMax: 0 }, "wire");
    expect(r.ok && r.src).toBe("fc.stringMatching(/^[a-z0-9]{0,0}$/)");
    const inst = instantiate<string>(r.ok ? r.src : "");
    fc.assert(fc.property(inst, (v) => v === ""));
  });
  it("fails for kinds without an arbitrary", () => {
    expect(constrainedArbitrary({ kind: "json", hint: "meta" }, null, "wire")).toMatchObject({ ok: false, reason: expect.stringContaining("json") });
  });
});
