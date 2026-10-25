/**
 * `@mrleebo/prisma-ast` ships a CJS `main` that `require`s the ESM-only `chevrotain`, which fails under
 * Node/tsx CJS resolution (`@chevrotain/utils` exposes only an `import` condition). The package has no
 * `exports` map, so the ESM build is importable by path; this declaration gives it the package's types.
 */
declare module "@mrleebo/prisma-ast/dist/prisma-ast.esm.js" {
  export * from "@mrleebo/prisma-ast";
}
