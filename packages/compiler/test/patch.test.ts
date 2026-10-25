import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEdits, applyFilePatch, changedLines, diffLineKeys, makePatch, parseUnifiedDiff, patchApplies, reversePatch } from "../src/patch.js";

const BEFORE = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n") + "\n";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("makePatch / applyFilePatch", () => {
  it("returns null for identical texts", () => {
    expect(makePatch("x.ts", BEFORE, BEFORE)).toBeNull();
  });

  it("produces one hunk per region with 3 context lines and applies", () => {
    const after = BEFORE.replace("b\n", "B\n").replace("k\n", "K\nK2\n");
    const patch = makePatch("x.ts", BEFORE, after) as string;
    expect(patch.startsWith("--- a/x.ts\n+++ b/x.ts\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n")).toBe(true);
    expect(patch.match(/^@@/gm)).toHaveLength(2);
    const [file] = parseUnifiedDiff(patch);
    expect(applyFilePatch(BEFORE, file!)).toBe(after);
  });

  it("handles a missing trailing newline on either side", () => {
    const a = "one\ntwo";
    const b = "one\ntwo\nthree\n";
    const p = makePatch("n.txt", a, b) as string;
    expect(p).toContain("\\ No newline at end of file");
    expect(applyFilePatch(a, parseUnifiedDiff(p)[0]!)).toBe(b);
    const back = makePatch("n.txt", b, a) as string;
    expect(applyFilePatch(b, parseUnifiedDiff(back)[0]!)).toBe(a);
  });

  it("refuses to apply when context does not match", () => {
    const patch = makePatch("x.ts", BEFORE, BEFORE.replace("f\n", "F\n")) as string;
    expect(patchApplies(patch, () => BEFORE)).toBe(true);
    expect(patchApplies(patch, () => BEFORE.replace("e\n", "E\n"))).toBe(false);
    expect(patchApplies(patch, () => null)).toBe(false);
  });

  it("reverses a patch", () => {
    const after = BEFORE.replace("c\n", "").replace("h\n", "h\nH\n");
    const files = parseUnifiedDiff(makePatch("x.ts", BEFORE, after) as string);
    expect(applyFilePatch(after, reversePatch(files)[0]!)).toBe(BEFORE);
  });

  it("maps changed lines on both sides", () => {
    const after = BEFORE.replace("c\n", "").replace("h\n", "h\nH\n");
    const [f] = changedLines(parseUnifiedDiff(makePatch("x.ts", BEFORE, after) as string));
    expect(f!.file).toBe("x.ts");
    expect(f!.oldRanges).toEqual([[3, 3]]);
    expect(f!.newRanges.some(([s, e]) => s <= 8 && e >= 8)).toBe(true);
  });

  it("applyEdits applies non-overlapping edits in any order and rejects overlaps", () => {
    expect(applyEdits("abcdef", [{ start: 4, end: 5, text: "E" }, { start: 0, end: 1, text: "A" }])).toBe("AbcdEf");
    expect(() => applyEdits("abcdef", [{ start: 0, end: 3, text: "" }, { start: 2, end: 4, text: "" }])).toThrow();
  });

  it("diffLineKeys yields an edit script that rebuilds both sides (property)", () => {
    const line = fc.constantFrom("a", "b", "c", "d", "");
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), fc.array(line, { maxLength: 30 }), (a, b) => {
        const ops = diffLineKeys(a, b);
        expect(ops.filter((o) => o.tag !== "+").map((o) => a[o.a])).toEqual(a);
        expect(ops.filter((o) => o.tag !== "-").map((o) => b[o.b])).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });

  it("every generated patch applies and yields the target (property)", () => {
    const text = fc.array(fc.constantFrom("x", "y", "z", "  w", ""), { maxLength: 25 }).map((ls) => ls.join("\n"));
    fc.assert(
      fc.property(text, text, fc.boolean(), fc.boolean(), (a0, b0, ea, eb) => {
        const a = ea ? `${a0}\n` : a0;
        const b = eb ? `${b0}\n` : b0;
        const p = makePatch("p.txt", a, b);
        if (p === null) return a === b;
        const files = parseUnifiedDiff(p);
        expect(applyFilePatch(a, files[0]!)).toBe(b);
        expect(applyFilePatch(b, reversePatch(files)[0]!)).toBe(a);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it.runIf(hasGit())("git apply --check accepts generated patches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "averri-patch-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src/x.ts"), BEFORE);
      const patch = makePatch("src/x.ts", BEFORE, BEFORE.replace("b\n", "B\n").replace("l\n", "l\nm\n")) as string;
      fs.writeFileSync(path.join(dir, "fix.patch"), patch);
      execFileSync("git", ["apply", "--check", "fix.patch"], { cwd: dir, stdio: "pipe" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
