/**
 * @averri/testgen — public option and result types.
 *
 * The generator is a pure function of (graph, options): no IO, no randomness. Everything that
 * varies per project (fixture names, generated directory, config path, entry point) is an option
 * the compiler lowers statically from `averri.config.ts` and passes in.
 */

import type { GeneratedTestSuite, NodeId, TestId } from "@averri/ir";

export interface GenerateOptions {
  /** `config.test.generatedDir`; repo-relative POSIX path. Default `"tests/averri"`. */
  generatedDir?: string;
  /** Repo-relative path of the project's `averri.config.ts`. Default `"averri.config.ts"`. */
  configFile?: string;
  /** Repo-relative path of the module exporting the HTTP app (`default` or `app`). Default `graph.meta.stack.entryPoints[0]`. */
  entryPoint?: string;
  /** Version written into the `@generated` header. Default `graph.meta.averriVersion`. */
  averriVersion?: string;
  /** Actor fixture names from `config.actors` (the auth matrix iterates all of them). Default `["anonymous"]`; `anonymous` is always included first. */
  actors?: readonly string[];
  /** `numRuns` for the emitted fast-check properties. Default 10 (every run hits the test database). */
  numRuns?: number;
  /** Restrict generation to these Test ids (`Test:gen/...`) or owner ids (`Action:...`, `Entity:...`, ...). */
  only?: readonly string[];
}

export interface ResolvedOptions {
  generatedDir: string;
  configFile: string;
  entryPoint: string | null;
  averriVersion: string;
  actors: readonly string[];
  numRuns: number;
  only: ReadonlySet<string> | null;
}

/** One planned generated suite = one future Test node (SPEC-IR §2.1 `Test:gen/<owner>.<suite>`). */
export interface PlannedSuite {
  id: TestId;
  owner: NodeId;
  suite: GeneratedTestSuite;
  /** Repo-relative path of the generated file (one file per owner). */
  file: string;
  /** The `describe` title; every `it` title starts with `[<id>]`. */
  title: string;
  /** Nodes the suite verifies: the owner plus the contracts/policy/event it asserts. */
  covers: NodeId[];
  /** Hash of the declaration content the owner's file derives from (shared by every suite of the owner). */
  sourceHash: string;
  /** Human reasons for `it.todo`s inside the suite (empty when fully derivable). */
  todos: string[];
}

export interface GeneratedFile {
  /** Repo-relative POSIX path, `<generatedDir>/<ownerQualifier>.gen.test.ts`. */
  path: string;
  content: string;
  /** The `hash:` field of the header (= `PlannedSuite.sourceHash`). */
  hash: string;
  owner: NodeId;
  /** Suites contained in the file, in emission order. */
  tests: TestId[];
}

export interface GeneratedHeader {
  averriVersion: string;
  owner: NodeId;
  hash: string;
}
