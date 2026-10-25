#!/usr/bin/env tsx
/**
 * `averri` executable. Development entry: `tsx packages/cli/src/bin.ts <command>`. The published
 * package compiles `src` to `dist` and points `bin` at `dist/bin.js` (build step to be added with the
 * release pipeline; ARCHITECTURE §7).
 */

import { run } from "./cli.js";

process.exitCode = await run(process.argv.slice(2));
