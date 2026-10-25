/**
 * Mutable state threaded through one build: the ts-morph project (shared with the extractors), the
 * node map and edge list being assembled, diagnostics, and the side facts verifiers and rules read.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Node as TsNode, SourceFile } from "ts-morph";
import type { ExtractResult, ProjectContext } from "@averri/extract";
import type { ContractId, Diagnostic, Edge, EntityId, EntityNode, Graph, Node, NodeId, Provenance, SourceRange } from "@averri/ir";
import type { LoweredConfig } from "./config.js";
import type { ContractFacts, DeclFacts, DeclSite } from "./model.js";

export interface BuildState {
  root: string;
  ctx: ProjectContext;
  config: LoweredConfig;
  extract: ExtractResult;
  nodes: Map<NodeId, Node>;
  edges: Edge[];
  diagnostics: Diagnostic[];
  sites: DeclSite[];
  /** call-site key (`file:start`) -> site */
  siteByCall: Map<string, DeclSite>;
  facts: DeclFacts[];
  factsById: Map<NodeId, DeclFacts>;
  contracts: Map<ContractId, ContractFacts>;
  /** clientName -> Entity id */
  entityByClient: Map<string, EntityId>;
  /** The previous build (A1002 rename detection), when cached. */
  previous: Graph | null;
  /** The graph pinned by last-green.json, when present. */
  lastGreen: Graph | null;
  rel(sf: SourceFile): string;
  text(file: string): string | null;
}

export function createState(
  root: string,
  ctx: ProjectContext,
  config: LoweredConfig,
  extract: ExtractResult,
  previous: Graph | null,
  lastGreen: Graph | null,
): BuildState {
  const nodes = new Map<NodeId, Node>();
  for (const n of extract.nodes) nodes.set(n.id, n);
  const entityByClient = new Map<string, EntityId>();
  for (const n of extract.nodes) if (n.kind === "Entity") entityByClient.set((n as EntityNode).clientName, n.id as EntityId);
  const texts = new Map<string, string | null>();
  return {
    root,
    ctx,
    config,
    extract,
    nodes,
    edges: [...extract.edges],
    diagnostics: [],
    sites: [],
    siteByCall: new Map(),
    facts: [],
    factsById: new Map(),
    contracts: new Map(),
    entityByClient,
    previous,
    lastGreen,
    rel: (sf) => ctx.rel(sf),
    text(file: string): string | null {
      if (texts.has(file)) return texts.get(file) ?? null;
      const sf = ctx.sourceFile(file);
      let t: string | null = null;
      if (sf) t = sf.getFullText();
      else {
        const abs = path.join(root, file);
        t = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
      }
      texts.set(file, t);
      return t;
    },
  };
}

export function callKey(file: string, node: TsNode): string {
  return `${file}:${node.getStart()}`;
}

export function declaredProvenance(src: SourceRange): Provenance {
  return { origin: "declared", declaredAt: src };
}

export function addEdge(state: BuildState, kind: Edge["kind"], from: NodeId, to: NodeId, provenance: Provenance, attrs?: Edge["attrs"]): void {
  const e: Edge = { kind, from, to, provenance };
  if (attrs) e.attrs = attrs;
  state.edges.push(e);
}
