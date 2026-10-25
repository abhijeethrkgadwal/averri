/**
 * `createRuntime(options)` binds a Prisma client and config once and returns the core-typed
 * `DeclaredRuntime` (`handle`, `toHono`, `toExpress`).
 */
import type { ActorOf, AdapterOptions, AnyActionDecl, AnyQueryDecl, DeclaredRuntime, HandleResult } from "@averri/core";
import { toExpress, toHono } from "./adapters.js";
import { handle, invoke, type InvokeOptions, type RuntimeOptions } from "./pipeline.js";

export interface Runtime extends DeclaredRuntime {
  readonly options: RuntimeOptions;
  /** One-shot invocation with explicit `input`/`actor`. */
  invoke<D extends AnyActionDecl | AnyQueryDecl>(decl: D, call: Omit<InvokeOptions, keyof RuntimeOptions> & Partial<RuntimeOptions>): Promise<HandleResult>;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  return {
    options,
    handle: <D extends AnyActionDecl | AnyQueryDecl>(decl: D) => handle(decl, options),
    toHono: <D extends AnyActionDecl | AnyQueryDecl, C>(decl: D, adapter: AdapterOptions<C, ActorOf<D>>) => toHono(decl, { ...options, ...adapter }),
    toExpress: <D extends AnyActionDecl | AnyQueryDecl, Req, Res>(decl: D, adapter: AdapterOptions<Req, ActorOf<D>>) =>
      toExpress<D, Req, Res>(decl, { ...options, ...adapter }),
    invoke: (decl, call) => invoke(decl, { ...options, ...call }),
  };
}
