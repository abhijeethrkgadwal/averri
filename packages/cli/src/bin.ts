#!/usr/bin/env node
/**
 * `averri` executable. Published as `dist/bin.js` (`bin` in package.json). Development entry:
 * `npm run averri -- <command>` (`tsx --conditions=development packages/cli/src/bin.ts`).
 */

import { run } from "./cli.js";

process.exitCode = await run(process.argv.slice(2));
