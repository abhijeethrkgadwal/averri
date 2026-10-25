/**
 * Call-time validation errors raised by the @averri/core constructors and builders.
 *
 * tsc is the first line of defence (literal unions, `policy | public` XOR, guard typing); these
 * errors are the runtime backstop for callers that bypass the types (JavaScript, `as any`,
 * generated code). Messages are precise and name the construct, the id and the offending option
 * so an agent can fix the declaration without reading the source of this package.
 */
export class AverriDeclarationError extends TypeError {
  override readonly name = "AverriDeclarationError";
  /** `entity`, `policy`, `action`, `query`, `event`, `workflow`, `integration`, `e`, `db`, `defineConfig`. */
  readonly construct: string;
  /** The declared id/name, or `null` for builders and `defineConfig`. */
  readonly id: string | null;
  /** The dotted option path the error refers to (`"requires.notAlreadyMember"`), or `null`. */
  readonly option: string | null;

  constructor(construct: string, id: string | null, option: string | null, detail: string) {
    const where = id === null ? `${construct}()` : `${construct}(${JSON.stringify(id)})`;
    super(option === null ? `${where}: ${detail}` : `${where}: option "${option}": ${detail}`);
    this.construct = construct;
    this.id = id;
    this.option = option;
  }
}

/** Short, stable description of a runtime value for error messages. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "function") return "a function";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "bigint") return `the bigint ${value}n`;
  return `${typeof value} ${String(value)}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
