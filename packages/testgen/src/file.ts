/**
 * One generated file per owner: prelude + derived machinery + suites. Owners are Actions/Queries
 * (auth-matrix, precondition, postcondition, event, pitfall.idempotency), Entities (invariant),
 * Events (consumer) and Integrations (pitfalls).
 */

import { parseNodeId, type ActionNode, type Node, type NodeId, type QueryNode, type WorkflowNode } from "@averri/ir";
import { emitActionCode, type ActionCode } from "./action-code.js";
import { ident, relativeImport } from "./emit.js";
import { consumersOf, sourceHashOf, writersOf } from "./hash.js";
import { buildActionModel, type Ctx } from "./model.js";
import { renderPrelude } from "./prelude.js";
import { authMatrixSuite, eventSuite, idempotencySuite, postconditionSuite, preconditionSuite, type SuiteCode } from "./suites/action.js";
import { consumerSuite, invariantSuite } from "./suites/entity-event.js";
import { integrationSuites } from "./suites/integration.js";
import type { PlannedSuite } from "./types.js";

export interface OwnerFile {
  owner: NodeId;
  path: string;
  content: string;
  hash: string;
  suites: PlannedSuite[];
}

/** Repo-relative module file a node was declared in (declaration modules only). */
export function moduleFileOf(n: Node): string | null {
  if (n.provenance.origin === "declared" || n.provenance.origin === "verified") return n.provenance.declaredAt.file;
  if (n.src && /\.(ts|tsx|mts|cts)$/.test(n.src.file)) return n.src.file;
  return null;
}

function actionSuites(ctx: Ctx, code: ActionCode): SuiteCode[] {
  return [authMatrixSuite(ctx, code), preconditionSuite(ctx, code), postconditionSuite(ctx, code), eventSuite(ctx, code), idempotencySuite(ctx, code)].filter(
    (s): s is SuiteCode => s !== null,
  );
}

function fileFor(ctx: Ctx, owner: Node): string {
  const qualifier = parseNodeId(owner.id)?.qualifier ?? owner.id;
  return `${ctx.options.generatedDir.replace(/\/+$/, "")}/${qualifier}.gen.test.ts`;
}

function assemble(ctx: Ctx, owner: Node, moduleFiles: string[], machinery: string[], suites: SuiteCode[], needsCrypto: boolean): OwnerFile {
  const path = fileFor(ctx, owner);
  const dir = ctx.options.generatedDir.replace(/\/+$/, "");
  const hash = sourceHashOf(ctx.graph, owner.id);
  const files = [...new Set(moduleFiles)].sort();
  const modules: Array<[string, string]> = files.map((f, i) => [`m${i}_${ident(f.replace(/\.(ts|tsx|mts|cts)$/, "").split("/").pop() ?? "mod")}`, relativeImport(dir, f)]);
  const prelude = renderPrelude({
    averriVersion: ctx.options.averriVersion,
    owner: owner.id,
    hash,
    configImport: relativeImport(dir, ctx.options.configFile),
    entryImport: ctx.options.entryPoint ? relativeImport(dir, ctx.options.entryPoint) : null,
    modules,
    fixtures: ctx.options.actors,
    numRuns: ctx.options.numRuns,
    needsCrypto,
  });
  const sections = [prelude];
  if (machinery.length > 0) sections.push("// --- derived arbitraries and fixtures ---", machinery.join("\n\n"));
  sections.push("// --- suites ---", suites.map((s) => s.code).join("\n\n"));
  const content = `${sections.join("\n\n")}\n`;
  const planned: PlannedSuite[] = suites.map((s) => ({
    id: s.id,
    owner: owner.id,
    suite: (parseNodeId(s.id)?.qualifier ?? "").slice(`gen/${parseNodeId(owner.id)?.qualifier ?? ""}.`.length) as PlannedSuite["suite"],
    file: path,
    title: `[${s.id}]`,
    covers: [...new Set(s.covers)].sort(),
    sourceHash: hash,
    todos: [...s.todos],
  }));
  return { owner: owner.id, path, content, hash, suites: planned };
}

export function buildOwnerFile(ctx: Ctx, owner: Node): OwnerFile | null {
  switch (owner.kind) {
    case "Action":
    case "Query": {
      const model = buildActionModel(ctx, owner as ActionNode | QueryNode);
      const code = emitActionCode(ctx, model);
      const suites = actionSuites(ctx, code);
      if (suites.length === 0) return null;
      // Integrations whose webhook is this route: the harness signs requests to it with the declared scheme.
      const exposure = (owner as ActionNode | QueryNode).route?.exposure ?? null;
      const webhooks = exposure === null ? [] : Object.values(ctx.graph.nodes).filter((n) => n.kind === "Integration" && n.webhook?.exposure === exposure);
      const files = [moduleFileOf(owner), model.policy ? moduleFileOf(model.policy) : null, ...webhooks.map((w) => moduleFileOf(w))].filter((f): f is string => f !== null);
      return assemble(ctx, owner, files, [code.code], suites, false);
    }
    case "Entity": {
      if (owner.invariants.length === 0) return null;
      const writers = writersOf(ctx.graph, owner.id)
        .map((id) => ctx.graph.nodes[id])
        .filter((n): n is ActionNode => n?.kind === "Action");
      const codes = writers.map((w) => emitActionCode(ctx, buildActionModel(ctx, w)));
      const suite = invariantSuite(ctx, owner, codes);
      if (!suite) return null;
      const files = [moduleFileOf(owner), ...writers.map((w) => moduleFileOf(w)), ...codes.map((c) => (c.model.policy ? moduleFileOf(c.model.policy) : null))].filter(
        (f): f is string => f !== null,
      );
      return assemble(ctx, owner, files, codes.map((c) => c.code), [suite], false);
    }
    case "Event": {
      const workflows = consumersOf(ctx.graph, owner.id)
        .map((id) => ctx.graph.nodes[id])
        .filter((n): n is WorkflowNode => n?.kind === "Workflow");
      const suite = consumerSuite(ctx, owner, workflows);
      if (!suite) return null;
      const files = [moduleFileOf(owner), ...workflows.map((w) => moduleFileOf(w))].filter((f): f is string => f !== null);
      return assemble(ctx, owner, files, [], [suite], false);
    }
    case "Integration": {
      const code = integrationSuites(ctx, owner);
      if (code.suites.length === 0) return null;
      const files = [moduleFileOf(owner)].filter((f): f is string => f !== null);
      return assemble(ctx, owner, files, code.prelude ? [code.prelude] : [], code.suites, code.needsCrypto);
    }
    default:
      return null;
  }
}
