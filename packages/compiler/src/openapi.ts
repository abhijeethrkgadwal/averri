/**
 * Derived OpenAPI 3.1 document (ARCHITECTURE §4 `openapi.json`): one operation per routed Action/Query
 * (declared ids as operationIds, intent as description, policy/contracts under `x-averri`), path
 * parameters from the route template, the request body/query from the input field names, entity
 * response schemas from the Prisma Field nodes, and the declared-mode error statuses. Undeclared
 * Exposures are listed with `x-averri.undeclared: true`.
 */

import type { ActionNode, EntityNode, ExposureNode, FieldNode, Graph, NodeId, QueryNode } from "@averri/ir";
import { compareStrings } from "./util.js";

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
}

/** `/teams/:teamId/x` → `/teams/{teamId}/x` and the param names. */
export function openApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const p = path.replace(/:([A-Za-z_$][\w$]*)(\{[^}]*\})?\??/g, (_m, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: p, params };
}

function fieldSchema(f: FieldNode): Record<string, unknown> | null {
  const t = f.type;
  let s: Record<string, unknown>;
  if (t.kind === "relation") return null;
  if (t.kind === "unsupported") s = {};
  else if (t.kind === "enum") s = { type: "string", enum: t.values };
  else {
    switch (t.name) {
      case "String":
        s = { type: "string" };
        break;
      case "Int":
        s = { type: "integer" };
        break;
      case "BigInt":
      case "Decimal":
        s = { type: "string", format: t.name === "BigInt" ? "int64" : "decimal" };
        break;
      case "Float":
        s = { type: "number" };
        break;
      case "Boolean":
        s = { type: "boolean" };
        break;
      case "DateTime":
        s = { type: "string", format: "date-time" };
        break;
      case "Json":
        s = {};
        break;
      case "Bytes":
        s = { type: "string", format: "byte" };
        break;
    }
  }
  if ("list" in t && t.list) s = { type: "array", items: s };
  if (f.optional) s = { anyOf: [s, { type: "null" }] };
  return s;
}

function entitySchema(graph: Graph, e: EntityNode): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const fid of e.fields) {
    const f = graph.nodes[fid] as FieldNode | undefined;
    if (!f) continue;
    const s = fieldSchema(f);
    if (!s) continue;
    const name = f.name.slice(f.name.indexOf(".") + 1);
    properties[name] = s;
    if (!f.optional) required.push(name);
  }
  return { type: "object", properties, required, ...(e.intent ? { description: e.intent } : {}) };
}

export function toOpenApi(graph: Graph, title = "Averri-derived API"): OpenApiDocument {
  const doc: OpenApiDocument = { openapi: "3.1.0", info: { title, version: graph.meta.averriVersion }, paths: {}, components: { schemas: {} } };
  const usedEntities = new Set<NodeId>();
  const decls = Object.values(graph.nodes)
    .filter((n): n is ActionNode | QueryNode => (n.kind === "Action" || n.kind === "Query") && (n as ActionNode).route !== null)
    .sort((a, b) => compareStrings(a.id, b.id));
  const covered = new Set<string>();
  for (const d of decls) {
    const route = d.route as NonNullable<ActionNode["route"]>;
    const { path, params } = openApiPath(route.path);
    covered.add(`${route.method} ${path}`);
    const method = route.method.toLowerCase();
    const bodyFields = d.input.fields.filter((f) => !params.includes(f));
    const op: Record<string, unknown> = {
      operationId: d.name,
      summary: d.name,
      ...(d.intent ? { description: d.intent } : {}),
      tags: [d.name.split(".")[0]],
    };
    const parameters: unknown[] = params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
    if (route.method === "GET" || route.method === "DELETE") {
      for (const f of bodyFields) parameters.push({ name: f, in: "query", required: false, schema: {} });
    } else if (bodyFields.length > 0) {
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: Object.fromEntries(bodyFields.map((f) => [f, {}])) } } },
      };
    }
    if (parameters.length) op.parameters = parameters;
    const ok: Record<string, unknown> = { description: "Success" };
    if ("entity" in d.output) {
      usedEntities.add(d.output.entity);
      ok.content = { "application/json": { schema: { $ref: `#/components/schemas/${d.output.entity.slice(7)}` } } };
    }
    const responses: Record<string, unknown> = { "200": ok, "400": { description: "ValidationFailed" } };
    if (!d.public) {
      responses["401"] = { description: "Unauthenticated" };
      responses["403"] = { description: "Forbidden (policy denied)" };
    }
    const contracts = d.kind === "Action" ? (d as ActionNode).contracts : [];
    if (contracts.some((c) => c.includes(".requires."))) responses["412"] = { description: "PreconditionFailed" };
    responses["500"] = { description: d.mode === "declared" ? "HandlerError or PostconditionFailed" : "Server error" };
    op.responses = responses;
    op["x-averri"] = {
      id: d.id,
      mode: d.mode,
      policy: d.policy,
      public: d.public,
      contracts,
      provenance: d.provenance.origin,
    };
    doc.paths[path] = { ...(doc.paths[path] ?? {}), [method]: op };
  }
  const exposures = Object.values(graph.nodes)
    .filter((n): n is ExposureNode => n.kind === "Exposure" && (n as ExposureNode).boundTo === null)
    .sort((a, b) => compareStrings(a.id, b.id));
  for (const x of exposures) {
    const { path, params } = openApiPath(x.path);
    if (covered.has(`${x.method} ${path}`)) continue;
    covered.add(`${x.method} ${path}`);
    const method = x.method.toLowerCase();
    doc.paths[path] = {
      ...(doc.paths[path] ?? {}),
      [method]: {
        operationId: x.id,
        summary: `${x.method} ${x.path} (undeclared)`,
        ...(params.length ? { parameters: params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })) } : {}),
        responses: { default: { description: "Undeclared route: response shape unknown" } },
        "x-averri": { id: x.id, undeclared: true, middleware: x.middleware },
      },
    };
  }
  for (const id of [...usedEntities].sort(compareStrings)) {
    const e = graph.nodes[id] as EntityNode | undefined;
    if (e) doc.components.schemas[e.model] = entitySchema(graph, e);
  }
  doc.paths = Object.fromEntries(Object.entries(doc.paths).sort(([a], [b]) => compareStrings(a, b)));
  return doc;
}
