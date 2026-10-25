/**
 * The agent block written by `averri init` into CLAUDE.md, AGENTS.md and .cursor/rules (SPEC-MCP §8).
 * Normative wording, <= 40 lines including the marker lines. Re-running init replaces the block between
 * the markers and leaves the rest of the file untouched.
 */

export const AGENT_BLOCK_BEGIN = "<!-- averri:begin -->";
export const AGENT_BLOCK_END = "<!-- averri:end -->";

/** Files `averri init` writes the block into, relative to the project root. */
export const AGENT_BLOCK_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md", ".cursor/rules"];

const BODY = [
  "## Averri (contracts and semantic graph for this backend)",
  "",
  "- Call `overview` once per session.",
  "- Call `find` or `impact` before editing an entity, route, policy or contract. Pass ids as `Action:Team.inviteMember` or bare `Team.inviteMember`, never file paths.",
  "- Run `check` instead of raw `tsc`/`vitest`. `check` regenerates `tests/averri/*.gen.test.ts`, so a diff touching them is expected.",
  "- Trust generated contract tests; do not edit `tests/averri/*.gen.test.ts`.",
  "- If a contract must be weakened or removed, say so explicitly in the PR description and pass `acknowledgeWeakening: true` to `check`.",
  '- Contracts: the left side of a comparison is a path string (`"result.email"`), the right side is `e.<root>()` or a literal. Tier-3 clauses are bare `async (ctx) => boolean` functions and get no generated tests, so prefer `e.*`/`db.*`.',
  "- When a tool says low-confidence or returns `verify`, use `read_source`.",
  "- Use `find` for entities, routes, policies, contracts and tests. Use grep for call sites of ordinary functions, middleware chains, env/config usage and error-message strings.",
  "- Prefer the first `fix` on a diagnostic; state in the PR when you chose another.",
  "- Construct docs: MCP resources `averri://docs/core`, `averri://docs/action`, `averri://docs/contracts`.",
];

export const AGENT_BLOCK_LINES: readonly string[] = [AGENT_BLOCK_BEGIN, ...BODY, AGENT_BLOCK_END];

/** The block text (LF line endings, trailing newline). */
export function agentBlock(): string {
  return `${AGENT_BLOCK_LINES.join("\n")}\n`;
}

/**
 * Insert or replace the block in an existing file's text. `existing` null or empty yields just the block.
 * Idempotent: applying it twice gives the same text.
 */
export function upsertAgentBlock(existing: string | null): string {
  const block = agentBlock();
  if (existing === null || existing.trim() === "") return block;
  const text = existing.replace(/\r\n/g, "\n");
  const b = text.indexOf(AGENT_BLOCK_BEGIN);
  const e = text.indexOf(AGENT_BLOCK_END);
  if (b >= 0 && e > b) {
    const tail = text.slice(e + AGENT_BLOCK_END.length).replace(/^\n/, "");
    return `${text.slice(0, b)}${block}${tail}`;
  }
  return `${text.replace(/\n*$/, "")}\n\n${block}`;
}

/** The MCP server registration the CLI writes into the detected agent's config (`.mcp.json` form). */
export function mcpServerRegistration(): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "@averri/cli", "mcp"] };
}
