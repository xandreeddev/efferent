import { Context, Effect, Layer, Schema } from "effect"
import { HarnessError, PLUGIN_API_VERSION } from "./plugin.entity.js"
import type { TypedPlugin } from "./plugin.entity.js"
import { isHarnessError, mergeOptions } from "./plugin.entity.functions.js"

/**
 * Layers retain their native types until the validated dynamic loading edge.
 * `build` (the graph's) and `live` (a host's own composition) share one
 * decode: the options merged over the defaults, extra keys refused — so a
 * graph caller, whose options already hold the defaults, decodes the same.
 * A `build` whose layer fails or dies with a `HarnessError` fails with that
 * error's code, as `live` does (and names the plugin when the error does
 * not); any other failure is `plugin.activation`, and any other defect
 * `plugin.defect`.
 */
export const definePlugin = <A extends Readonly<Record<string, unknown>>, I, Out, E, In>(definition: {
  readonly id: string
  readonly version: string
  readonly apiVersion?: number
  readonly scope?: "runtime" | "session"
  readonly requires?: ReadonlyArray<{ readonly key: string }>
  readonly provides: ReadonlyArray<{ readonly key: string }>
  readonly contributes?: ReadonlyArray<{ readonly key: string }>
  readonly optional?: ReadonlyArray<{ readonly key: string }>
  readonly config: Schema.Codec<A, I>
  readonly defaults: A
  readonly layer: (config: A) => Layer.Layer<Out, E, In>
}): TypedPlugin<A, I, Out, E, In> => {
  const decodeOptions = (options: unknown): Effect.Effect<A, Schema.SchemaError> => Schema.decodeUnknownEffect(definition.config)(
    typeof options === "object" && options !== null ? mergeOptions(definition.config, definition.defaults, options) : options ?? definition.defaults,
    { onExcessProperty: "error" },
  )
  const named = (error: HarnessError) => new HarnessError({ code: error.code, message: error.message, plugin: error.plugin ?? definition.id })
  return {
    id: definition.id,
    version: definition.version,
    apiVersion: definition.apiVersion ?? PLUGIN_API_VERSION,
    scope: definition.scope ?? "session",
    requires: (definition.requires ?? []).map((tag) => tag.key),
    provides: definition.provides.map((tag) => tag.key),
    contributes: (definition.contributes ?? []).map((tag) => tag.key),
    optional: (definition.optional ?? []).map((tag) => tag.key),
    schema: definition.config,
    config: definition.config,
    defaults: definition.defaults,
    build: (options, services) => decodeOptions(options).pipe(
      // Each activation builds its own layers (v4 would reuse ones the caller
      // memoized), and exposes only what it provides.
      Effect.flatMap((config) => Layer.build(Layer.fresh(definition.layer(config))).pipe(
        Effect.provide(Context.makeUnsafe<In>(services.mapUnsafe)),
        Effect.map((built) => Context.makeUnsafe<never>(Context.omit(Layer.CurrentMemoMap)(built).mapUnsafe)),
      )),
      // A layer that fails with a HarnessError keeps its code (skills.duplicate, not plugin.activation), as `live` does.
      // Matched by its fields, not `instanceof`: a plugin built against another copy of core fails with that copy's class.
      Effect.mapError((error) => isHarnessError(error)
        ? named(error)
        : new HarnessError({ code: "plugin.activation", plugin: definition.id, message: String(error) })),
      // One that dies with a HarnessError (an `Effect.orDie` over its own failure) keeps its code too.
      Effect.catchDefect((defect) => Effect.fail(isHarnessError(defect)
        ? named(defect)
        : new HarnessError({ code: "plugin.defect", plugin: definition.id, message: String(defect) }))),
    ),
    live: (options) => Layer.unwrap(decodeOptions(options).pipe(
      Effect.mapError((error) => new HarnessError({ code: "config.options", plugin: definition.id, message: String(error) })),
      Effect.map(definition.layer),
    )),
  }
}
