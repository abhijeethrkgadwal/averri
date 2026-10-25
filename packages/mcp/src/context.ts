/** Tool context: the project root plus the compiler options the server passes through. */

import type { CheckOptions, LoadOptions } from "@averri/compiler";

export interface ToolContext {
  /** Absolute project root. */
  root: string;
  /** Passed to `loadOrBuildWithInfo` (config file, git on/off, lock timeout). */
  load?: LoadOptions;
  /** Passed to `check` (injectable tsc/vitest runners, git on/off). */
  check?: Pick<CheckOptions, "tsc" | "vitest" | "git" | "now" | "baseGraph">;
}
