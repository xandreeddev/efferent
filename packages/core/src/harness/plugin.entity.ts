import { Schema } from "effect"
import type { Context, Effect, Layer, Scope } from "effect"

/**
 * The plugin API this core speaks. Version 3: the turn's writer and the
 * ports over it fail with `TurnError` (`TurnClosed`, `ReservedKind`,
 * `SessionContended`, `SessionLogError` raised as their tags, no longer as
 * `HarnessError` codes).
 */
export const PLUGIN_API_VERSION = 3
/** Version 1 (no capabilities, no optional services) and version 2 plugins still load. */
export const SUPPORTED_PLUGIN_API_VERSIONS: ReadonlyArray<number> = [1, 2, 3]

/**
 * A framework failure, told apart by its `code` (`harnessCodeOf`). `cause`
 * is what failed underneath, kept as a value for logs: it encodes as its
 * name and message only, and `reasonOf` never reads it.
 */
export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  code: Schema.String,
  message: Schema.String,
  plugin: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The runtime consumes this erased boundary; authors use definePlugin. */
export interface Plugin {
  readonly id: string
  readonly version: string
  readonly apiVersion: number
  readonly scope: "runtime" | "session"
  readonly requires: ReadonlyArray<string>
  readonly provides: ReadonlyArray<string>
  /** Multi-provider keys: every contributor's array is concatenated in graph order. */
  readonly contributes: ReadonlyArray<string>
  /** Used when present (ordering and dependencies), never required. */
  readonly optional: ReadonlyArray<string>
  readonly schema: Schema.Codec<any, any>
  readonly defaults: Readonly<Record<string, unknown>>
  readonly build: (
    options: unknown,
    services: Context.Context<never>,
  ) => Effect.Effect<Context.Context<never>, HarnessError, Scope.Scope>
}

/**
 * A plugin's options as a host gives them: any key may be left out, at any
 * depth of nested objects, and takes its default (`mergeOptions`).
 *
 * @public
 */
export type PartialOptions<T> = T extends ReadonlyArray<unknown> | ((...args: never) => unknown) ? T
  : T extends object ? { readonly [K in keyof T]?: PartialOptions<T[K]> }
  : T

/**
 * A plugin as its author defined it (see `definePlugin`): the erased
 * `Plugin` the runtime loads, plus its typed parts. `live` is the plugin's
 * own layer, with the services it provides and requires in its type, for
 * hosts that compose layers themselves (see `stackPlugins`).
 *
 * @public
 */
export interface TypedPlugin<A extends Readonly<Record<string, unknown>>, I, Out, E, In> extends Plugin {
  readonly config: Schema.Codec<A, I>
  readonly defaults: A
  /** Options merged over the defaults (`mergeOptions`) and decoded (extra keys fail with config.options). */
  readonly live: (options?: PartialOptions<I>) => Layer.Layer<Out, E | HarnessError, In>
}
