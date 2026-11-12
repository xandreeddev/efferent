import { Effect, Layer } from "effect"
import type { Context, Scope } from "effect"
import { CurrentPlugin } from "./core.port.js"
import { PluginName } from "./ids.entity.js"

/**
 * A plugin: an Effect layer with a name. What it needs and what it provides
 * are the layer's type; its name is the prefix of the events it writes
 * (`plugin.<name>.`) and the name of the listeners it registers. A plugin a
 * package ships also states its version, the package's.
 */
export interface Plugin<Provides, E = never, R = never> {
  readonly name: PluginName
  readonly version?: string
  readonly layer: Layer.Layer<Provides, E, R>
}

/** What a plugin is defined from, whatever it provides. */
interface PluginSpec<E, R, S> {
  readonly name: string
  /** The version of the package that ships the plugin; a plugin written by a host or a test states none. */
  readonly version?: string
  readonly make: Effect.Effect<S, E, R>
}

/**
 * Define a plugin from its name, the contract it provides and the effect
 * that makes it. `make` runs once, in the plugin's scope: what it registers
 * with `Core.on` and what it acquires are released when that scope closes.
 * A plugin that only listens leaves `provides` out.
 */
export function definePlugin<I, S, E, R>(spec: PluginSpec<E, R, S> & { readonly provides: Context.Key<I, S> }): Plugin<I, E, Exclude<R, Scope.Scope>>
export function definePlugin<E, R>(spec: PluginSpec<E, R, void>): Plugin<never, E, Exclude<R, Scope.Scope>>
export function definePlugin<I, S, E, R>(spec: PluginSpec<E, R, S> & { readonly provides?: Context.Key<I, S> }): Plugin<never, E, Exclude<R, Scope.Scope>> {
  const name = PluginName.make(spec.name)
  const make = Effect.provideService(spec.make, CurrentPlugin, name)
  const layer = spec.provides === undefined ? Layer.effectDiscard(make) : Layer.effect(spec.provides, make)
  return spec.version === undefined ? { name, layer } : { name, version: spec.version, layer }
}
