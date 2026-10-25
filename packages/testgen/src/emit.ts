/**
 * Small, deterministic code-emission helpers. Everything here returns TypeScript source text.
 */

import type { LitScalar } from "@averri/ir";

/** A double-quoted TS string literal. */
export function str(s: string): string {
  return JSON.stringify(s);
}

/** TS source for a contract literal (string, number, boolean, null or a list of those). */
export function litSource(value: LitScalar | LitScalar[]): string {
  if (Array.isArray(value)) return `[${value.map((v) => litSource(v)).join(", ")}]`;
  if (value === null) return "null";
  if (typeof value === "string") return str(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "Number.NaN";
    if (value === Number.POSITIVE_INFINITY) return "Number.POSITIVE_INFINITY";
    if (value === Number.NEGATIVE_INFINITY) return "Number.NEGATIVE_INFINITY";
    return Object.is(value, -0) ? "-0" : String(value);
  }
  return value ? "true" : "false";
}

/** Turn any string into a valid identifier fragment (`Team.inviteMember` -> `Team_inviteMember`). */
export function ident(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Member access source: dot form when the key is an identifier, bracket form otherwise. */
export function member(objectSrc: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${objectSrc}.${key}` : `${objectSrc}[${str(key)}]`;
}

/** Object-literal key source: bare when it is an identifier, quoted otherwise. */
export function keySource(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : str(key);
}

export function indent(text: string, level = 1): string {
  const pad = "  ".repeat(level);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : pad + line))
    .join("\n");
}

/** Join non-empty blocks with a blank line between them. */
export function blocks(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}

export function lines(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

/** POSIX dirname without a trailing slash; `""` for a bare file name. */
export function posixDirname(file: string): string {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
}

/**
 * Relative ESM import specifier from `fromDir` (a repo-relative directory) to `file` (a repo-relative
 * `.ts`/`.tsx` file), with the `.js` extension NodeNext requires and a leading `./` or `../`.
 */
export function relativeImport(fromDir: string, file: string): string {
  const from = fromDir.split("/").filter((s) => s.length > 0 && s !== ".");
  const to = file.split("/").filter((s) => s.length > 0 && s !== ".");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const ups = from.length - common;
  const rest = to.slice(common);
  const parts = [...Array<string>(ups).fill(".."), ...rest];
  let spec = parts.join("/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec.replace(/\.(ts|tsx|mts|cts)$/, (m) => (m === ".mts" ? ".mjs" : m === ".cts" ? ".cjs" : ".js"));
}

/** `it.todo("<title>")` line. */
export function todo(title: string): string {
  return `it.todo(${str(title)});`;
}

/** Comment block (each line prefixed with `// `). */
export function comment(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.length === 0 ? "//" : `// ${l}`))
    .join("\n");
}
