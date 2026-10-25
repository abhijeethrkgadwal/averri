import { describe, expect, it } from "vitest";
import { promoteHandlerModules } from "../src/build.js";

describe("promoteHandlerModules", () => {
  it("keeps a promoted Module summary within the 200-character schema cap", () => {
    const longSummary = `other module src/services/billing.ts · 300 lines · exports ${"x".repeat(200)}`.slice(0, 197) + "...";
    expect(longSummary.length).toBe(200);
    const nodes = new Map<string, any>([
      ["Module:src/services/billing.ts", {
        id: "Module:src/services/billing.ts", kind: "Module", role: "other", summary: longSummary,
        provenance: { origin: "extracted", evidence: [{ note: "role (other)" }] },
      }],
    ]);
    const edges = [{ kind: "implementedBy", from: "Action:Billing.handle", to: "Module:src/services/billing.ts" }];
    promoteHandlerModules({ nodes, edges } as any);
    const promoted = nodes.get("Module:src/services/billing.ts");
    expect(promoted.role).toBe("handler");
    expect(promoted.summary.startsWith("handler module ")).toBe(true);
    expect(promoted.summary.length).toBeLessThanOrEqual(200);
  });
});
