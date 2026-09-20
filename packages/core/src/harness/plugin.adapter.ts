import { Context, Effect, Layer, Schema } from "effect"
import { HarnessError, PLUGIN_API_VERSION } from "./plugin.entity.js"
import type { Plugin } from "./plugin.entity.js"

/** Layers retain their native types until the validated dynamic loading edge. */
export const definePlugin = <A extends Readonly<Record<string, unknown>>, I, Out, E, In>(definition: {
  readonly id: string
  readonly version: string
  readonly apiVersion?: number
  readonly scope?: "runtime" | "session"
  readonly requires?: ReadonlyArray<{ readonly key: string }>
  readonly provides: ReadonlyArray<{ readonly key: string }>
  readonly config: Schema.Schema<A, I>
  readonly defaults: A
  readonly layer: (config: A) => Layer.Layer<Out, E, In>
}): Plugin => ({
  id: definition.id,
  version: definition.version,
  apiVersion: definition.apiVersion ?? PLUGIN_API_VERSION,
  scope: definition.scope ?? "session",
  requires: (definition.requires ?? []).map((tag) => tag.key),
  provides: definition.provides.map((tag) => tag.key),
  schema: definition.config,
  defaults: definition.defaults,
  build: (options, services) => Schema.decodeUnknown(definition.config)(options, { onExcessProperty: "error" }).pipe(
    Effect.flatMap((config) => Layer.build(definition.layer(config)).pipe(
      Effect.provide(Context.unsafeMake<In>(services.unsafeMap)),
      Effect.map((built) => Context.unsafeMake<never>(built.unsafeMap)),
    )),
    Effect.mapError((error) => new HarnessError({ code: "plugin.activation", plugin: definition.id, message: String(error) })),
    Effect.catchAllDefect((error) => Effect.fail(new HarnessError({ code: "plugin.defect", plugin: definition.id, message: String(error) }))),
  ),
})
