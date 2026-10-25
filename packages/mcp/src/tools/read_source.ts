import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool } from "../define.js";
import { tokensOf, type Outcome } from "../envelope.js";
import { isIgnored } from "../gitignore.js";

export const READ_SOURCE_BUDGET = 4000;

export const inputSchema = z.object({
  file: z.string(),
  range: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
});

export interface ReadSourceData {
  file: string;
  range: [number, number];
  text: string;
  lines: number;
}

const posix = (p: string): string => p.split(path.sep).join("/");

function insideRoot(rootReal: string, target: string): boolean {
  const rel = path.relative(rootReal, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function readSource(root: string, file: string, range?: [number, number]): Outcome<ReadSourceData> {
  const rootReal = fs.realpathSync(root);
  const abs = path.resolve(root, file);
  const relLexical = path.relative(path.resolve(root), abs);
  if (relLexical === "" || relLexical.startsWith("..") || path.isAbsolute(relLexical)) {
    return { ok: false, error: "bad-input", message: `${file} is outside the project root` };
  }
  if (!fs.existsSync(abs)) return { ok: false, error: "not-found", message: `no file ${posix(relLexical)}` };
  const real = fs.realpathSync(abs);
  if (!insideRoot(rootReal, real)) return { ok: false, error: "bad-input", message: `${file} resolves outside the project root` };
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { ok: false, error: "bad-input", message: `${posix(relLexical)} is not a file` };
  const rel = posix(path.relative(rootReal, real));
  const traces = rel === ".averri/traces" || rel.startsWith(".averri/traces/");
  if (!traces && isIgnored(rootReal, rel, false)) {
    return { ok: false, error: "bad-input", message: `${rel} is ignored by .gitignore (only .averri/traces is readable)` };
  }
  const all = fs.readFileSync(real, "utf8").split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const total = all.length;
  const [start, end] = range ?? [1, total];
  if (end < start) return { ok: false, error: "bad-input", message: `range end ${end} is before start ${start}` };
  if (start > total) return { ok: false, error: "bad-input", message: `${rel} has ${total} lines; range starts at ${start}` };
  const last = Math.min(end, total);
  const taken: string[] = [];
  for (let n = start; n <= last; n++) {
    const next = [...taken, all[n - 1] as string];
    const probe: ReadSourceData = { file: rel, range: [start, n], text: next.join("\n"), lines: next.length };
    if (tokensOf(probe) > READ_SOURCE_BUDGET) {
      if (taken.length === 0) return { ok: false, error: "bad-input", message: `line ${n} alone exceeds the ${READ_SOURCE_BUDGET}-token budget` };
      break;
    }
    taken.push(all[n - 1] as string);
  }
  const reached = start + taken.length - 1;
  const truncated = reached < last;
  return {
    ok: true,
    data: { file: rel, range: [start, reached], text: taken.join("\n"), lines: taken.length },
    truncated,
    ...(truncated ? { more: [`${rel}:${reached + 1}`] } : {}),
  };
}

export const readSourceTool = defineTool(
  "read_source",
  "Read a project file by 1-based inclusive line range, whole lines only. Refuses paths outside the root and gitignored files. Budget 4000 tokens.",
  inputSchema,
  ({ input, ctx }) => readSource(ctx.root, input.file, input.range),
);
