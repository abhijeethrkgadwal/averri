/**
 * Suites owned by an Entity (invariant) and by an Event (consumer).
 */

import { generatedTestId, type EntityNode, type EventNode, type NodeId, type WorkflowNode } from "@averri/ir";
import type { ActionCode } from "../action-code.js";
import { comment, indent, lines, str, todo } from "../emit.js";
import type { Ctx } from "../model.js";
import type { SuiteCode } from "./action.js";

function describeBlock(id: string, body: string[]): string {
  return [`describe(${str(`[${id}]`)}, () => {`, indent(lines(...body)), "});"].join("\n");
}

export function invariantSuite(ctx: Ctx, entity: EntityNode, writers: ActionCode[]): SuiteCode | null {
  if (entity.invariants.length === 0) return null;
  const id = generatedTestId(entity.id, "invariant");
  const covers: NodeId[] = [entity.id, ...entity.invariants.map((c) => c as NodeId)];
  const todos: string[] = [];
  const entityLit = str(entity.id);
  const body: string[] = [
    comment("Every invariant is evaluated over findMany() of the model (observe-mode diff; declared mode also reports it as 500 PostconditionFailed)."),
    `const INVARIANTS = [${entity.invariants.map((c) => str(c)).join(", ")}];`,
    `it(${str(`[${id}] invariants hold on the current rows`)}, async () => {`,
    `  expect(await h.invariantViolations(${entityLit})).toEqual([]);`,
    "});",
  ];
  const ready = writers.filter((w) => w.ready.ok);
  const unready = writers.filter((w) => !w.ready.ok);
  for (const w of unready) todos.push(`writer ${w.model.owner} cannot be invoked: ${w.ready.ok ? "" : w.ready.reasons.join("; ")}`);
  const propertyTitle = `[${id}] 1-5 generated writes preserve the invariants`;
  if (ready.length === 0) {
    const reason = writers.length === 0 ? `${propertyTitle}: no Action writes ${entity.model}` : `${propertyTitle}: ${todos.join("; ")}`;
    todos.push(reason);
    body.push(todo(reason));
    return { id, covers, todos, code: describeBlock(id, body) };
  }
  if (unready.length > 0) body.push(comment(`writers skipped: ${unready.map((w) => w.model.owner).join(", ")}`));
  body.push(
    `const WRITERS = [${ready.map((w) => str(w.model.owner)).join(", ")}] as const;`,
    "async function runWriter(writer: (typeof WRITERS)[number]): Promise<Invoked> {",
    "  switch (writer) {",
    ...ready.map((w) =>
      [
        `    case ${str(w.model.owner)}: {`,
        `      const input = drawInput(h, ${str(w.model.owner)}, ${w.validInput});`,
        `      return (await ${w.invokeAllowed}(h, input)).res;`,
        "    }",
      ].join("\n"),
    ),
    "  }",
    "}",
    `it(${str(propertyTitle)}, async () => {`,
    indent(
      lines(
        "await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom(...WRITERS), { minLength: 1, maxLength: 5 }), async (sequence) => {",
        indent(
          lines(
            "for (const writer of sequence) {",
            "  const res = await runWriter(writer);",
            "  if (res.status === 500) expect(INVARIANTS, `${writer} reported an invariant failure`).not.toContain(errorBody(res).contract);",
            `  expect(await h.invariantViolations(${entityLit}), \`after \${writer}\`).toEqual([]);`,
            "}",
          ),
        ),
        "}), { numRuns: NUM_RUNS });",
      ),
    ),
    "}, PROPERTY_TIMEOUT_MS);",
  );
  return { id, covers, todos, code: describeBlock(id, body) };
}

export function consumerSuite(ctx: Ctx, event: EventNode, workflows: WorkflowNode[]): SuiteCode | null {
  if (workflows.length === 0) return null;
  const id = generatedTestId(event.id, "consumer");
  const covers: NodeId[] = [event.id, ...workflows.map((w) => w.id as NodeId)];
  const body: string[] = [comment("A consumer exists when the workflow's runner is registered for config.emitter.eventNamePrefix + the event name.")];
  for (const w of workflows) {
    body.push(
      `it(${str(`[${id}] [${w.id}] consumer is registered for ${event.name}`)}, async () => {`,
      `  expect(await h.consumerRegistered(${str(event.id)}, ${str(w.id)}), ${str(`${w.id} must subscribe to ${event.name}`)}).toBe(true);`,
      "});",
    );
  }
  return { id, covers, todos: [], code: describeBlock(id, body) };
}
