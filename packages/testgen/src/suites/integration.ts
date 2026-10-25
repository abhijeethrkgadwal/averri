/**
 * Pitfall suites owned by an Integration: webhook-signature, raw-body, idempotency (SPEC-CONTRACTS §9).
 * Signing follows the declared scheme: `stripe` (t=<ts>,v1=hmac(secret, `${ts}.${body}`)) and
 * `hmac-sha256` (hex hmac over the raw body in the `verify` header); `custom` gets the tampered-body
 * test only. The secret comes from `process.env[secretEnv]`; the signed tests are skipped when unset.
 */

import { generatedTestId, type ExposureNode, type IntegrationNode, type NodeId } from "@averri/ir";
import { comment, indent, lines, str, todo } from "../emit.js";
import { node, type Ctx } from "../model.js";
import type { SuiteCode } from "./action.js";

function describeBlock(id: string, body: string[]): string {
  return [`describe(${str(`[${id}]`)}, () => {`, indent(lines(...body)), "});"].join("\n");
}

export interface IntegrationCode {
  /** Shared constants and helpers (emitted once per file). */
  prelude: string;
  suites: SuiteCode[];
  needsCrypto: boolean;
}

export const SAMPLE_BODY = JSON.stringify({ id: "evt_averri_1", object: "event", type: "averri.test", data: { object: {} } });
export const NON_CANONICAL_BODY = '{ "id" : "evt_averri_2",  "type":"averri.test",\n  "object": "event", "data": {"object": {}} }';

export function integrationSuites(ctx: Ctx, integration: IntegrationNode): IntegrationCode {
  const suites: SuiteCode[] = [];
  const webhook = integration.webhook;
  const exposure: ExposureNode | null = webhook ? node(ctx, webhook.exposure, "Exposure") : null;
  const preludeParts: Array<string | null> = [];
  let needsCrypto = false;

  if (webhook) {
    const sigId = generatedTestId(integration.id, "pitfall.webhook-signature");
    const covers: NodeId[] = [integration.id];
    if (!exposure) {
      const reason = `[${sigId}] webhook route is not resolved to an Exposure (declare webhook.route or register the handler)`;
      suites.push({ id: sigId, covers, todos: [reason], code: describeBlock(sigId, [todo(reason)]) });
      if (webhook.rawBody) {
        const rawId = generatedTestId(integration.id, "pitfall.raw-body");
        const rawReason = `[${rawId}] webhook route is not resolved to an Exposure`;
        suites.push({ id: rawId, covers, todos: [rawReason], code: describeBlock(rawId, [todo(rawReason)]) });
      }
    } else {
      const canSign = webhook.scheme !== "custom" && webhook.secretEnv !== null;
      needsCrypto = canSign;
      preludeParts.push(
        `const WEBHOOK = { method: ${str(exposure.method)}, path: ${str(exposure.path)} } as const;`,
        `const SIGNATURE_HEADER = ${str(webhook.verify)};`,
        canSign ? `const SECRET_ENV = ${str(webhook.secretEnv as string)};` : null,
        canSign ? "const secret = process.env[SECRET_ENV];" : null,
        `const SAMPLE_BODY = ${str(SAMPLE_BODY)};`,
        webhook.rawBody && canSign ? `const NON_CANONICAL_BODY = ${str(NON_CANONICAL_BODY)};` : null,
        canSign
          ? webhook.scheme === "stripe"
            ? lines(
                "function sign(body: string, key: string): Record<string, string> {",
                "  const t = Math.floor(Date.now() / 1000);",
                '  const v1 = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");',
                "  return { [SIGNATURE_HEADER]: `t=${t},v1=${v1}` };",
                "}",
              )
            : lines(
                "function sign(body: string, key: string): Record<string, string> {",
                '  return { [SIGNATURE_HEADER]: createHmac("sha256", key).update(body).digest("hex") };',
                "}",
              )
          : null,
        "async function deliver(body: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {",
        '  return h.rawRequest({ method: WEBHOOK.method, path: WEBHOOK.path, headers: { "content-type": "application/json", ...headers }, body });',
        "}",
      );

      const sigBody: string[] = [comment(`scheme: ${webhook.scheme}; signature header: ${webhook.verify}; secret from env ${webhook.secretEnv ?? "(none)"}`)];
      if (canSign) {
        sigBody.push(
          `it.skipIf(secret === undefined)(${str(`[${sigId}] validly signed body is accepted`)}, async () => {`,
          "  const res = await deliver(SAMPLE_BODY, sign(SAMPLE_BODY, secret as string));",
          "  expect(is2xx(res.status), `signed webhook: expected 2xx, got ${res.status} ${JSON.stringify(res.body)}`).toBe(true);",
          "});",
          `it.skipIf(secret === undefined)(${str(`[${sigId}] tampered body is rejected`)}, async () => {`,
          "  const headers = sign(SAMPLE_BODY, secret as string);",
          '  const res = await deliver(SAMPLE_BODY.replace("evt_averri_1", "evt_averri_tampered"), headers);',
          '  expect(is2xx(res.status), "a body that does not match its signature must be rejected").toBe(false);',
          "});",
        );
      } else {
        sigBody.push(
          `it(${str(`[${sigId}] tampered body is rejected`)}, async () => {`,
          '  const res = await deliver(SAMPLE_BODY, { [SIGNATURE_HEADER]: "averri-invalid-signature" });',
          '  expect(is2xx(res.status), "a body with an invalid signature must be rejected").toBe(false);',
          "});",
        );
      }
      suites.push({ id: sigId, covers, todos: [], code: describeBlock(sigId, sigBody) });

      if (webhook.rawBody) {
        const rawId = generatedTestId(integration.id, "pitfall.raw-body");
        if (canSign) {
          suites.push({
            id: rawId,
            covers,
            todos: [],
            code: describeBlock(rawId, [
              comment("Catches handlers that re-serialise the parsed JSON before verifying: the signature covers the bytes as sent."),
              `it.skipIf(secret === undefined)(${str(`[${rawId}] validly signed non-canonical body is accepted`)}, async () => {`,
              "  const res = await deliver(NON_CANONICAL_BODY, sign(NON_CANONICAL_BODY, secret as string));",
              "  expect(is2xx(res.status), `non-canonical signed body: expected 2xx, got ${res.status} ${JSON.stringify(res.body)}`).toBe(true);",
              "});",
            ]),
          });
        } else {
          const reason = `[${rawId}] scheme "custom" cannot produce a validly signed body`;
          suites.push({ id: rawId, covers, todos: [reason], code: describeBlock(rawId, [todo(reason)]) });
        }
      }

      if (integration.idempotency) {
        const idemId = generatedTestId(integration.id, "pitfall.idempotency");
        const tables = ctx.facts.entities().map((e) => e.clientName);
        if (canSign) {
          suites.push({
            id: idemId,
            covers,
            todos: [],
            code: describeBlock(idemId, [
              comment("Single effect = identical after-snapshots of every table after the first and the second delivery of the same signed body; the second response is not 5xx (D-11)."),
              `const TABLES = [${tables.map((t) => str(t)).join(", ")}];`,
              `it.skipIf(secret === undefined)(${str(`[${idemId}] duplicate delivery has a single effect`)}, async () => {`,
              "  const headers = sign(SAMPLE_BODY, secret as string);",
              "  const first = await deliver(SAMPLE_BODY, headers);",
              "  expect(is2xx(first.status), `first delivery: expected 2xx, got ${first.status}`).toBe(true);",
              "  const after1 = await h.snapshot(TABLES);",
              "  const second = await deliver(SAMPLE_BODY, headers);",
              '  expect(second.status, "second delivery must not fail with 5xx").toBeLessThan(500);',
              "  const after2 = await h.snapshot(TABLES);",
              '  expect(after2, "second delivery must not change any table").toEqual(after1);',
              "});",
            ]),
          });
        } else {
          const reason = `[${idemId}] scheme "custom" cannot produce an accepted delivery to repeat`;
          suites.push({ id: idemId, covers, todos: [reason], code: describeBlock(idemId, [todo(reason)]) });
        }
      }
    }
  } else if (integration.idempotency) {
    const idemId = generatedTestId(integration.id, "pitfall.idempotency");
    const reason = `[${idemId}] idempotency on an integration without a webhook has no delivery to repeat`;
    suites.push({ id: idemId, covers: [integration.id], todos: [reason], code: describeBlock(idemId, [todo(reason)]) });
  }

  return { prelude: preludeParts.filter((p): p is string => typeof p === "string").join("\n"), suites, needsCrypto };
}
