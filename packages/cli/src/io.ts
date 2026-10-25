/** Process abstraction so the program can be driven from tests (`run(argv, io)`), plus exit codes. */

export const EXIT_OK = 0;
export const EXIT_DIAGNOSTICS = 1;
export const EXIT_USAGE = 2;

export interface Io {
  /** Project root; `--root` overrides. */
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Read all of stdin (for `impact --diff -`). */
  stdin: () => Promise<string>;
  /** Colour human output. */
  color: boolean;
}

export function processIo(): Io {
  return {
    cwd: process.cwd(),
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    stdin: () =>
      new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => (data += c));
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
      }),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  };
}

/** A failure the caller wants rendered as a usage error (exit 2). */
export class UsageError extends Error {}
