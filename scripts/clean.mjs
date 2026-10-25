#!/usr/bin/env node
// Remove every package's build output (dist/) and tsc incremental state (.tsbuildinfo).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgs = path.join(root, "packages");
for (const name of fs.readdirSync(pkgs)) {
  for (const rel of ["dist", ".tsbuildinfo", "tsconfig.tsbuildinfo"]) {
    fs.rmSync(path.join(pkgs, name, rel), { recursive: true, force: true });
  }
}
console.log("cleaned packages/*/dist");
