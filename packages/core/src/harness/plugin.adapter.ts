import { Cause, Context, Effect, Layer, Schema } from "effect"
import { reasonOf } from "../domain/failure.entity.functions.js"
import { HarnessError, PLUGIN_API_VERSION } from "./plugin.entity.js"
import type { TypedPlugin } from "./plugin.entity.js"
import { isHarnessError, mergeOptions, provideDeclared } from "./plugin.entity.functions.js"
import type { ServiceKeys } from "./plugin.entity.functions.js"

/**
 * Layers retain their native types until the validated dynamic loading edge.
 * The layer may need only the services `requires` lists (a Reference adds
 * nothing): one that reads an undeclared service does not compile. A
 * service in `optional` is read with `Effect.serviceOption`, so it is not
 * in the layer's type; the graph orders the plugin after its provider and
 * hands it over when there is one. `build` provides the layer what the
 * graph gives it, once every required key is there (`provideDeclared`:
 * `requires.missing` otherwise).
 * `build` (the graph's) and `live` (a host's own composition) share one
 * decode: the options merged over the defaults, extra keys refused — so a
 * graph caller, whose options already hold the defaults, decodes the same.
 * A `build` whose layer fails or dies with a `HarnessError` fails with that
 * error's code and cause, as `live` does (and names the plugin when the
 * error does not); any other failure is `plugin.activation`, and any other
 * defect `plugin.defect`. Either keeps what failed as its `cause`, and its
 * message names the plugin and what failed (`reasonOf`: messages, never a
 * stack). `config.options` keeps the schema's failure the same way.
 */
export const definePlugin = <
  A extends Readonly<Record<string, unknown>>, I, Out, E,
  In extends Context.Service.Identifier<Req[number]>,
  const Req extends ServiceKeys = readonly [],
>(definition: {
  readonly id: string
  readonly version: string
  readonly apiVersion?: number
  readonly scope?: "runtime" | "session"
  readonly requires?: Req
  readonly provides: ReadonlyArray<{ readonly key: string }>
  readonly contributes?: ReadonlyArray<{ readonly key: string }>
  readonly optional?: ServiceKeys
  readonly config: Schema.Codec<A, I>
  readonly defaults: A
  readonly layer: (config: A) => Layer.Layer<Out, E, In>
}): TypedPlugin<A, I, Out, E, In> => {
  const requires = definition.requires ?? ([] as const)
  const decodeOptions = (options: unknown): Effect.Effect<A, Schema.SchemaError> => Schema.decodeUnknownEffect(definition.config)(
    typeof options === "object" && options !== null ? mergeOptions(definition.config, definition.defaults, options) : options ?? definition.defaults,
    { onExcessProperty: "error" },
  )
  const named = (error: HarnessError) => new HarnessError({
    code: error.code, message: error.message, plugin: error.plugin ?? definition.id,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  })
  return {
    id: definition.id,
    version: definition.version,
    apiVersion: definition.apiVersion ?? PLUGIN_API_VERSION,
    scope: definition.scope ?? "session",
    requires: requires.map((tag) => tag.key),
    provides: definition.provides.map((tag) => tag.key),
    contributes: (definition.contributes ?? []).map((tag) => tag.key),
    optional: (definition.optional ?? []).map((tag) => tag.key),
    schema: definition.config,
    config: definition.config,
    defaults: definition.defaults,
    build: (options, services) => decodeOptions(options).pipe(
      // Each activation builds its own layers (v4 would reuse ones the caller
      // memoized), in the caller's scope, and exposes only what it provides.
      Effect.flatMap((config) => Effect.flatMap(Effect.scope, (scope) => Layer.buildWithScope(Layer.fresh(definition.layer(config)), scope).pipe(
        provideDeclared(definition.id, requires),
        Effect.provide(services),
        Effect.map((built) => Context.makeUnsafe<never>(Context.omit(Layer.CurrentMemoMap)(built).mapUnsafe)),
      ))),
      // A layer that fails with a HarnessError keeps its code (skills.duplicate, not plugin.activation), as `live` does.
      // Matched by its fields, not `instanceof`: a plugin built against another copy of core fails with that copy's class.
      Effect.mapError((error) => isHarnessError(error)
        ? named(error)
        : new HarnessError({
          code: "plugin.activation", plugin: definition.id,
          message: `${definition.id} failed to activate: ${reasonOf(Cause.fail(error))}`, cause: error,
        })),
      // One that dies with a HarnessError (an `Effect.orDie` over its own failure) keeps its code too.
      Effect.catchDefect((defect) => Effect.fail(isHarnessError(defect)
        ? named(defect)
        : new HarnessError({
          code: "plugin.defect", plugin: definition.id,
          message: `${definition.id} died while activating: ${reasonOf(Cause.die(defect))}`, cause: defect,
        }))),
    ),
    live: (options) => Layer.unwrap(decodeOptions(options).pipe(
      Effect.mapError((error) => new HarnessError({ code: "config.options", plugin: definition.id, message: error.message, cause: error })),
      Effect.map(definition.layer),
    )),
  }
}
