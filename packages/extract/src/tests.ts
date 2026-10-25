/**
 * Hand-written Vitest test discovery -> Test nodes (`Test:<file>:<line>`, one per `it`/`test` call).
 *
 * `covers` comes from `// @averri covers Action:X, Policy:Y` comments (a comment before the first
 * `describe`/`it` applies to the whole file; a comment directly above a `describe` applies to its
 * tests; above an `it` to that test) and from node-id string literals found inside the test body.
 * The compiler's `test-link` verifier turns `covers` into `verifiedBy` edges; the extractor emits
 * only `contains` edges from the test Module.
 *
 * Confidence: 0.95 for a test with a literal title in a file importing `vitest`; 0.8 when the file
 * does not import vitest (globals or another runner); 0.6 when the title is not a literal (`it.each`).
 */

import { Node, type CallExpression, type SourceFile } from "ts-morph";
import { handWrittenTestId, moduleId, parseNodeId, type Edge, type Evidence, type NodeId, type TestNode } from "@averri/ir";
import type { ProjectContext } from "./project.js";
import { staticString, unwrap } from "./resolve.js";
import type { ExtractWarning } from "./types.js";
import { extracted, positionOf, rangeOf, summary, uniq } from "./util.js";

export const TEST_CONFIDENCE = { literal: 0.95, noVitestImport: 0.8, dynamicTitle: 0.6 } as const;

const TEST_FNS = new Set(["it", "test"]);
const DESCRIBE_FNS = new Set(["describe", "suite"]);
const COVERS_RE = /@averri\s+covers\s+([^\n*]+)/g;
const COVERABLE_KINDS = new Set(["Action", "Query", "Policy", "Contract", "Event", "Workflow", "Integration", "Exposure", "Entity"]);

export interface TestExtraction {
  nodes: TestNode[];
  edges: Edge[];
  warnings: ExtractWarning[];
  /** Files that contained at least one test call (role `test`). */
  testFiles: string[];
}

export function extractTests(ctx: ProjectContext, files: readonly string[] = ctx.testFiles): TestExtraction {
  const nodes: TestNode[] = [];
  const edges: Edge[] = [];
  const warnings: ExtractWarning[] = [];
  const testFiles: string[] = [];
  for (const rel of files) {
    const sf = ctx.sourceFile(rel);
    if (!sf) continue;
    const found = extractTestFile(sf, rel, warnings);
    if (found.length === 0) continue;
    testFiles.push(rel);
    for (const node of found) {
      nodes.push(node);
      edges.push({
        kind: "contains",
        from: moduleId(rel),
        to: node.id,
        provenance: extracted("vitest", 1, [{ kind: "test", note: `${rel} defines ${node.title}` }]),
      });
    }
  }
  return { nodes, edges, warnings, testFiles };
}

interface TestCall {
  call: CallExpression;
  kind: "test" | "describe";
  title: string | null;
  line: number;
}

function extractTestFile(sf: SourceFile, rel: string, warnings: ExtractWarning[]): TestNode[] {
  const importsVitest = sf.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === "vitest");
  const calls: TestCall[] = [];
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const kind = testCallKind(node);
    if (!kind) return;
    const first = node.getArguments()[0];
    const title = first ? staticString(first) : null;
    calls.push({ call: node, kind, title, line: node.getStartLineNumber() });
  });
  if (calls.length === 0) return [];

  const coversByLine = coversComments(sf.getFullText());
  const fileLevel: NodeId[] = [];
  const perCall = new Map<CallExpression, NodeId[]>();
  const firstCallLine = Math.min(...calls.map((c) => c.line));
  for (const [line, ids] of coversByLine) {
    if (line < firstCallLine) {
      fileLevel.push(...ids);
      continue;
    }
    const target = calls.filter((c) => c.line > line).sort((a, b) => a.line - b.line)[0];
    if (!target) {
      fileLevel.push(...ids);
      continue;
    }
    perCall.set(target.call, [...(perCall.get(target.call) ?? []), ...ids]);
  }

  const nodes: TestNode[] = [];
  for (const tc of calls) {
    if (tc.kind !== "test") continue;
    const describes = ancestorDescribes(tc.call, calls);
    const titleParts = [...describes.map((d) => d.title ?? "(dynamic)"), tc.title ?? "(dynamic)"];
    const title = titleParts.join(" > ");
    const covers = uniq<NodeId>([
      ...fileLevel,
      ...describes.flatMap((d) => perCall.get(d.call) ?? []),
      ...(perCall.get(tc.call) ?? []),
      ...idLiteralsIn(tc.call),
    ]);
    const src = rangeOf(rel, tc.call);
    let confidence: number = importsVitest ? TEST_CONFIDENCE.literal : TEST_CONFIDENCE.noVitestImport;
    const evidence: Evidence[] = [{ kind: "test", note: `${calleeText(tc.call)}(${JSON.stringify(tc.title ?? "(dynamic)")}) at ${rel}:${tc.line}`, src }];
    if (tc.title === null) {
      confidence = TEST_CONFIDENCE.dynamicTitle;
      warnings.push({ code: "test-title-dynamic", message: `${rel}:${tc.line}: test title is not a string literal`, file: rel, src });
    }
    if (covers.length > 0) evidence.push({ kind: "test", note: `covers ${covers.join(", ")}` });
    const pos = positionOf(sf, tc.call.getStart());
    nodes.push({
      id: handWrittenTestId(rel, pos[0]),
      kind: "Test",
      name: title,
      summary: summary(`hand-written test ${rel}:${pos[0]} · ${title}${covers.length ? ` · covers ${covers.length}` : ""}`),
      provenance: extracted("vitest", confidence, evidence),
      src,
      generated: false,
      suite: "hand-written",
      file: rel,
      title,
      covers,
      lastResult: null,
    });
  }
  return nodes;
}

/** `it`, `test`, `it.skip`, `test.only`, `it.concurrent.skip`, `it.each([...])(...)`; same for describe/suite. */
function testCallKind(call: CallExpression): "test" | "describe" | null {
  const callee = unwrap(call.getExpression());
  let root: Node = callee;
  if (Node.isCallExpression(root)) {
    // it.each(table)("title", fn): the outer call is the registration.
    root = unwrap(root.getExpression());
  }
  while (Node.isPropertyAccessExpression(root)) root = unwrap(root.getExpression());
  if (!Node.isIdentifier(root)) return null;
  // Reject the inner `it.each(table)` call itself (its parent chain is the registration).
  const parent = call.getParent();
  if (Node.isCallExpression(parent) && unwrap(parent.getExpression()) === call) return null;
  const name = root.getText();
  if (TEST_FNS.has(name)) return "test";
  if (DESCRIBE_FNS.has(name)) return "describe";
  return null;
}

function calleeText(call: CallExpression): string {
  return call.getExpression().getText().replace(/\s+/g, "");
}

function ancestorDescribes(call: CallExpression, calls: TestCall[]): TestCall[] {
  const describes = calls.filter((c) => c.kind === "describe");
  const out: TestCall[] = [];
  let cur: Node | undefined = call.getParent();
  while (cur) {
    if (Node.isCallExpression(cur)) {
      const d = describes.find((x) => x.call === cur);
      if (d) out.unshift(d);
    }
    cur = cur.getParent();
  }
  return out;
}

function coversComments(text: string): Map<number, NodeId[]> {
  const out = new Map<number, NodeId[]>();
  COVERS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COVERS_RE.exec(text)) !== null) {
    const line = text.slice(0, m.index).split("\n").length;
    const ids = m[1]!
      .split(/[,\s]+/)
      .map((s) => s.trim().replace(/[*/]+$/, ""))
      .filter((s) => s.length > 0 && isCoverableId(s)) as NodeId[];
    if (ids.length > 0) out.set(line, [...(out.get(line) ?? []), ...ids]);
  }
  return out;
}

function isCoverableId(s: string): boolean {
  const parsed = parseNodeId(s);
  return parsed !== null && COVERABLE_KINDS.has(parsed.kind) && !/\s/.test(parsed.qualifier);
}

function idLiteralsIn(call: CallExpression): NodeId[] {
  const out: NodeId[] = [];
  call.forEachDescendant((n) => {
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) {
      const v = n.getLiteralText();
      if (isCoverableId(v)) out.push(v as NodeId);
    }
  });
  return out;
}
