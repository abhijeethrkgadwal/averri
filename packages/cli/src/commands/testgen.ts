/**
 * `averri testgen [--only <id>]`: (re)generate `tests/averri/*.gen.test.ts` from the graph. Without
 * `--only` this is the compiler's writer (rewrites changed files, deletes orphaned generated files).
 * With `--only` only the selected files are written and nothing is deleted.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadOrBuild, readConfig, sameGeneratedContent, writeGeneratedTests, AVERRI_VERSION, type GeneratedFilesReport } from "@averri/compiler";
import { generateTests, type GenerateOptions } from "@averri/testgen";

export interface TestgenResult extends GeneratedFilesReport {
  only: string[];
}

export async function testgen(root: string, only: string[] = []): Promise<TestgenResult> {
  const graph = await loadOrBuild(root);
  const { config } = readConfig(root);
  const options: GenerateOptions = {
    generatedDir: config.test.generatedDir,
    configFile: config.file ?? "averri.config.ts",
    averriVersion: AVERRI_VERSION,
    actors: config.actors,
  };
  const entry = config.entryPoints[0] ?? graph.meta.stack.entryPoints[0];
  if (entry) options.entryPoint = entry;
  const report: GeneratedFilesReport = { written: [], unchanged: [], deleted: [] };
  if (only.length === 0) {
    writeGeneratedTests(root, graph, options, report);
    return { ...report, only };
  }
  for (const f of generateTests(graph, { ...options, only })) {
    const abs = path.join(root, f.path);
    const onDisk = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (onDisk !== null && sameGeneratedContent(onDisk, f.content)) {
      report.unchanged.push(f.path);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    report.written.push(f.path);
  }
  return { ...report, only };
}
