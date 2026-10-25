/**
 * Static lowering of `averri.config.ts` (SPEC-DECLARATIONS §9): the compiler reads only the static
 * fields (`sourceRoots`, `prismaSchema`, `prismaClient`, `entryPoints`, `publicMarker`,
 * `authMiddleware`, `emitter.eventNamePrefix`, fixture names, `test`) with ts-morph and never imports
 * the file. A static field outside the analysable subset is A1004 and falls back to its default.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Node, Project, type ObjectLiteralExpression, type SourceFile } from "ts-morph";
import { moduleId, type Diagnostic } from "@averri/ir";
import { emit } from "./diagnostics.js";
import { evalLiteral, propertyKey, unwrapExpr, type Literal } from "./lower/literal.js";
import { rangeOf } from "./util.js";

export const CONFIG_FILES = ["averri.config.ts", "averri.config.mts", "averri.config.cts", "averri.config.js", "averri.config.mjs"] as const;

export interface LoweredConfig {
  /** Repo-relative path of the config module, or null when the project has none. */
  file: string | null;
  sourceRoots: string[];
  prismaSchema: string;
  prismaClient: { file: string; symbol: string } | null;
  entryPoints: string[];
  /** True when `entryPoints` was written (otherwise the extractor detects them). */
  entryPointsDeclared: boolean;
  publicMarker: string | null;
  authMiddleware: string[];
  /** `emitter.eventNamePrefix`; null when the project configures no emitter. */
  eventNamePrefix: string | null;
  /** Actor fixture names (keys of `actors`), in source order. */
  actors: string[];
  /** Static `actor.id` literal per fixture (null for anonymous or non-literal ids); used by `explain`. */
  actorIds: Record<string, string | null>;
  test: { databaseUrlEnv: string; generatedDir: string };
}

export const CONFIG_DEFAULTS: Omit<LoweredConfig, "file"> = {
  sourceRoots: ["src"],
  prismaSchema: "prisma/schema.prisma",
  prismaClient: null,
  entryPoints: [],
  entryPointsDeclared: false,
  publicMarker: null,
  authMiddleware: [],
  eventNamePrefix: null,
  actors: ["anonymous"],
  actorIds: { anonymous: null },
  test: { databaseUrlEnv: "DATABASE_URL", generatedDir: "tests/averri" },
};

export interface ConfigResult {
  config: LoweredConfig;
  diagnostics: Diagnostic[];
}

/** Locate the config module (first of {@link CONFIG_FILES} that exists). */
export function findConfigFile(rootDir: string): string | null {
  return CONFIG_FILES.find((f) => fs.existsSync(path.join(rootDir, f))) ?? null;
}

/** Read and lower the project's config. Missing file → defaults, no diagnostics. */
export function readConfig(rootDir: string, configFile?: string | null): ConfigResult {
  const file = configFile === undefined ? findConfigFile(rootDir) : configFile;
  if (!file || !fs.existsSync(path.join(rootDir, file))) return { config: { file: null, ...clone(CONFIG_DEFAULTS) }, diagnostics: [] };
  const text = fs.readFileSync(path.join(rootDir, file), "utf8");
  return lowerConfigText(file, text);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Lower config source text (exported for tests). */
export function lowerConfigText(file: string, text: string): ConfigResult {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile(`/${file}`, text, { overwrite: true });
  const config: LoweredConfig = { file, ...clone(CONFIG_DEFAULTS) };
  const diagnostics: Diagnostic[] = [];
  const obj = configObject(sf);
  const node = moduleId(file);
  if (!obj) {
    diagnostics.push(
      emit("A1004", {
        node,
        src: { file, range: [[1, 0], [1, 0]] },
        message: `${file}: the default export is not defineConfig({...}) or an object literal; config defaults are used`,
      }),
    );
    return { config, diagnostics };
  }
  const bad = (prop: Node, what: string, reason: string): void => {
    diagnostics.push(
      emit("A1004", {
        node,
        src: rangeOf(file, prop),
        message: `config option ${what} is not statically analysable (${reason}); the default is used`,
      }),
    );
  };
  for (const p of obj.getProperties()) {
    if (!Node.isPropertyAssignment(p)) continue;
    const key = propertyKey(p);
    const init = p.getInitializer();
    if (key === null || !init) continue;
    switch (key) {
      case "sourceRoots":
      case "entryPoints":
      case "authMiddleware": {
        const r = evalLiteral(init);
        if (r.ok && isStringArray(r.value)) {
          config[key] = r.value;
          if (key === "entryPoints") config.entryPointsDeclared = true;
        } else bad(p, key, r.ok ? "expected an array of strings" : r.reason);
        break;
      }
      case "prismaSchema": {
        const r = evalLiteral(init);
        if (r.ok && typeof r.value === "string") config.prismaSchema = r.value;
        else bad(p, key, r.ok ? "expected a string" : r.reason);
        break;
      }
      case "publicMarker": {
        const r = evalLiteral(init);
        if (r.ok && (typeof r.value === "string" || r.value === null)) config.publicMarker = r.value;
        else bad(p, key, r.ok ? "expected a string" : r.reason);
        break;
      }
      case "prismaClient": {
        const r = evalLiteral(init);
        if (r.ok && isRecordOf(r.value) && typeof r.value.file === "string" && typeof r.value.symbol === "string") {
          config.prismaClient = { file: r.value.file, symbol: r.value.symbol };
        } else bad(p, key, r.ok ? "expected { file, symbol }" : r.reason);
        break;
      }
      case "test": {
        const r = evalLiteral(init);
        if (r.ok && isRecordOf(r.value)) {
          if (typeof r.value.databaseUrlEnv === "string") config.test.databaseUrlEnv = r.value.databaseUrlEnv;
          if (typeof r.value.generatedDir === "string") config.test.generatedDir = r.value.generatedDir;
        } else bad(p, key, r.ok ? "expected an object" : r.reason);
        break;
      }
      case "actors": {
        const u = unwrapExpr(init);
        if (Node.isObjectLiteralExpression(u)) {
          const names: string[] = [];
          const ids: Record<string, string | null> = {};
          for (const ap of u.getProperties()) {
            const k = propertyKey(ap);
            if (k === null) {
              bad(ap, "actors", "a fixture name must be a static key");
              continue;
            }
            names.push(k);
            ids[k] = actorIdOf(ap);
          }
          config.actors = names;
          config.actorIds = ids;
        } else bad(p, key, "expected an object literal of fixtures");
        break;
      }
      case "emitter": {
        const u = unwrapExpr(init);
        if (Node.isNullLiteral(u)) {
          config.eventNamePrefix = null;
          break;
        }
        if (!Node.isObjectLiteralExpression(u)) {
          bad(p, key, "expected an object literal");
          break;
        }
        const prefix = u.getProperty("eventNamePrefix");
        if (prefix && Node.isPropertyAssignment(prefix)) {
          const pi = prefix.getInitializer();
          const r = pi ? evalLiteral(pi) : null;
          if (r && r.ok && typeof r.value === "string") config.eventNamePrefix = r.value;
          else bad(prefix, "emitter.eventNamePrefix", r && !r.ok ? r.reason : "expected a string");
        } else {
          config.eventNamePrefix = "";
        }
        break;
      }
      default:
        break;
    }
  }
  return { config, diagnostics };
}

/** `{ actor: { id: "u_1" } }` -> "u_1" (null when absent or not a literal). */
function actorIdOf(fixture: Node): string | null {
  if (!Node.isPropertyAssignment(fixture)) return null;
  const v = fixture.getInitializer();
  const obj = v ? unwrapExpr(v) : undefined;
  if (!obj || !Node.isObjectLiteralExpression(obj)) return null;
  const actor = obj.getProperty("actor");
  const ai = actor && Node.isPropertyAssignment(actor) ? actor.getInitializer() : undefined;
  const ao = ai ? unwrapExpr(ai) : undefined;
  if (!ao || !Node.isObjectLiteralExpression(ao)) return null;
  const idp = ao.getProperty("id");
  const ii = idp && Node.isPropertyAssignment(idp) ? idp.getInitializer() : undefined;
  const r = ii ? evalLiteral(ii) : null;
  return r && r.ok && typeof r.value === "string" ? r.value : null;
}

function isStringArray(v: Literal): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isRecordOf(v: Literal): v is { [key: string]: Literal } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The object literal passed to `defineConfig` in the default export (following one local `const`). */
function configObject(sf: SourceFile): ObjectLiteralExpression | null {
  const ea = sf.getExportAssignment((e) => !e.isExportEquals());
  if (!ea) return null;
  return objectOf(ea.getExpression(), sf, 0);
}

function objectOf(expr: Node, sf: SourceFile, depth: number): ObjectLiteralExpression | null {
  if (depth > 3) return null;
  const u = unwrapExpr(expr);
  if (Node.isObjectLiteralExpression(u)) return u;
  if (Node.isCallExpression(u)) {
    const arg = u.getArguments()[0];
    return arg ? objectOf(arg, sf, depth + 1) : null;
  }
  if (Node.isIdentifier(u)) {
    const decl = sf.getVariableDeclaration(u.getText());
    const init = decl?.getInitializer();
    return init ? objectOf(init, sf, depth + 1) : null;
  }
  return null;
}
