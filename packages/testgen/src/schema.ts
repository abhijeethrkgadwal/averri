/**
 * Schema facts view over a graph: entities by client accessor, fields by entity, relation walking
 * for flat `where` keys, and the FK-scalar convention the fixture generator relies on.
 */

import { parseNodeId, type EntityId, type EntityNode, type FieldNode, type Graph, type Node, type NodeId } from "@averri/ir";
import { analyseClause, mergeConjunction, type Atom, type FieldConstraint } from "./constraints.js";

export interface ResolvedWhereKey {
  /** Relation hops taken (field nodes, all to-one), outermost first. */
  hops: FieldNode[];
  /** The entity owning the final field. */
  entity: EntityNode;
  /** The final field, or null when it does not exist. */
  field: FieldNode | null;
  /** True when a hop crosses a list relation (A3009 territory). */
  crossesList: boolean;
}

export class SchemaFacts {
  private readonly byClient = new Map<string, EntityNode>();
  private readonly byId = new Map<string, EntityNode>();
  private readonly fieldsByEntity = new Map<string, FieldNode[]>();
  private readonly columnConstraints = new Map<string, Map<string, FieldConstraint>>();

  constructor(readonly graph: Pick<Graph, "nodes">) {
    const ids = Object.keys(graph.nodes).sort();
    for (const id of ids) {
      const node = graph.nodes[id as NodeId] as Node;
      if (node.kind === "Entity") {
        this.byClient.set(node.clientName, node);
        this.byId.set(node.id, node);
      }
    }
    for (const id of ids) {
      const node = graph.nodes[id as NodeId] as Node;
      if (node.kind === "Field") {
        const list = this.fieldsByEntity.get(node.entity) ?? [];
        list.push(withBareName(node));
        this.fieldsByEntity.set(node.entity, list);
      }
    }
    for (const id of ids) {
      const node = graph.nodes[id as NodeId] as Node;
      if (node.kind === "Entity") this.columnConstraints.set(node.id, unconditionalConstraints(graph, node));
    }
    for (const [, list] of this.fieldsByEntity) list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  entityByClient(clientName: string): EntityNode | null {
    return this.byClient.get(clientName) ?? null;
  }

  entity(id: EntityId | string): EntityNode | null {
    return this.byId.get(id) ?? null;
  }

  entities(): EntityNode[] {
    return [...this.byId.values()];
  }

  /** Fields of an entity in name order (from Field nodes; the entity's `fields` list is not needed). */
  fields(entity: EntityNode | EntityId): FieldNode[] {
    const id = typeof entity === "string" ? entity : entity.id;
    return this.fieldsByEntity.get(id) ?? [];
  }

  field(entity: EntityNode | EntityId, name: string): FieldNode | null {
    return this.fields(entity).find((f) => f.name === name) ?? null;
  }

  /**
   * Per-column constraints every row must meet, from the entity's single-comparison invariants
   * (`e.in("role", [...])`, `e.gte("version", 1)`). Fixture rows draw unpinned columns within them so
   * seeded data stays inside the app's domain (D-40). Conditional invariants (`or`/`and`) are ignored.
   */
  columnConstraint(entity: EntityNode | EntityId, field: string): FieldConstraint | null {
    const id = typeof entity === "string" ? entity : entity.id;
    return this.columnConstraints.get(id)?.get(field) ?? null;
  }

  /** Resolve a flat where key (`user.email`) from `entity` through to-one relations. */
  resolveWhereKey(entity: EntityNode, key: string): ResolvedWhereKey {
    const segments = key.split(".");
    const hops: FieldNode[] = [];
    let current = entity;
    let crossesList = false;
    for (let i = 0; i < segments.length - 1; i++) {
      const hop = this.field(current, segments[i] as string);
      if (!hop || hop.type.kind !== "relation") return { hops, entity: current, field: null, crossesList };
      if (hop.type.list) crossesList = true;
      hops.push(hop);
      const next = this.entity(hop.type.to);
      if (!next) return { hops, entity: current, field: null, crossesList };
      current = next;
    }
    return { hops, entity: current, field: this.field(current, segments[segments.length - 1] as string), crossesList };
  }

  /**
   * The scalar foreign-key field backing a to-one relation field, by convention (`team` -> `teamId`,
   * `team_id`, `teamID`). The IR does not record `@relation(fields:)`, so this is a heuristic.
   */
  fkFieldFor(entity: EntityNode, relation: FieldNode): FieldNode | null {
    const candidates = [`${relation.name}Id`, `${relation.name}_id`, `${relation.name}ID`];
    for (const c of candidates) {
      const f = this.field(entity, c);
      if (f && f.type.kind === "scalar" && !f.type.list) return f;
    }
    return null;
  }

  /** Required to-one relation fields of an entity (non-optional, non-list). */
  requiredRelations(entity: EntityNode): FieldNode[] {
    return this.fields(entity).filter((f) => f.type.kind === "relation" && !f.type.list && !f.optional);
  }

  /** Required scalar/enum fields without a default (what a `create` must supply). */
  requiredScalars(entity: EntityNode): FieldNode[] {
    return this.fields(entity).filter((f) => (f.type.kind === "scalar" || f.type.kind === "enum") && !f.optional && !f.hasDefault);
  }

  /** Single-field primary key, or null for compound/absent ids. */
  singleIdField(entity: EntityNode): FieldNode | null {
    if (entity.idFields.length !== 1) return null;
    return this.field(entity, entity.idFields[0] as string);
  }
}

/**
 * SPEC-IR: a node `name` is its qualifier, so extracted Field nodes are named `<Model>.<field>`.
 * Everything in testgen works with the bare column name; derive it from the id (`Field:<Model>.<field>`).
 */
function withBareName(node: FieldNode): FieldNode {
  const qualifier = parseNodeId(node.id)?.qualifier ?? node.name;
  const model = entityQualifier(node.entity);
  const bare = qualifier.startsWith(`${model}.`) ? qualifier.slice(model.length + 1) : node.name;
  return bare === node.name ? node : { ...node, name: bare };
}

function unconditionalConstraints(graph: Pick<Graph, "nodes">, entity: EntityNode): Map<string, FieldConstraint> {
  const atoms: Atom[] = [];
  for (const cid of entity.invariants) {
    const c = graph.nodes[cid];
    if (!c || c.kind !== "Contract" || c.expr === null) continue;
    if (c.expr.op === "and" || c.expr.op === "or" || c.expr.op === "not") continue;
    const a = analyseClause(c.expr);
    if (a.ok && a.satisfy.length === 1 && a.satisfy[0]?.root === "self") atoms.push(a.satisfy[0]);
  }
  const merged = mergeConjunction(atoms);
  const out = new Map<string, FieldConstraint>();
  if (merged.ok) for (const f of merged.fields) out.set(f.field, f);
  return out;
}

export function entityQualifier(id: EntityId | string): string {
  return parseNodeId(id)?.qualifier ?? id;
}
