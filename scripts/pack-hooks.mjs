#!/usr/bin/env node
// npm prepack/postpack hook for every published package (run with cwd = the package directory).
//   prepack:  build (tsc -b, so a pack can never ship stale or missing dist), copy the root LICENSE in,
//             and drop the in-repo-only "development" export condition (it points at ./src, which is not
//             published; a consumer's Vite/Vitest would otherwise try to resolve it).
//   postpack: restore package.json and remove the LICENSE copy.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = process.cwd();
const manifest = path.join(pkgDir, "package.json");
const backup = path.join(pkgDir, ".package.json.prepack-bak");
const license = path.join(pkgDir, "LICENSE");
const mode = process.argv[2];

function restore() {
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, manifest);
    fs.rmSync(backup);
  }
  fs.rmSync(license, { force: true });
}

if (mode === "postpack") {
  restore();
} else if (mode === "prepack") {
  restore(); // recover from an interrupted earlier pack
  const tsc = createRequire(path.join(root, "package.json")).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-b"], { cwd: pkgDir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  fs.copyFileSync(path.join(root, "LICENSE"), license);
  const original = fs.readFileSync(manifest, "utf8");
  const pkg = JSON.parse(original);
  for (const entry of Object.values(pkg.exports ?? {})) {
    if (entry && typeof entry === "object") delete entry.development;
  }
  fs.copyFileSync(manifest, backup);
  fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
} else {
  console.error("usage: pack-hooks.mjs prepack|postpack");
  process.exit(2);
}
