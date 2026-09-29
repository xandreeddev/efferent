import { Context, Effect, Layer, Option } from "effect"
import { Capabilities } from "../ports/capability.port.js"
import type { Capability } from "../ports/capability.port.js"

/** The host's own bundles as a layer: the bottom of a plugin stack (see `stackPlugins`). */
export const CapabilitiesLive = (...bundles: ReadonlyArray<Capability>): Layer.Layer<Capabilities> =>
  Layer.succeed(Capabilities, bundles)

const capabilitiesOf = (context: Context.Context<never>): ReadonlyArray<Capability> =>
  Option.getOrElse(Context.getOption(context, Capabilities), (): ReadonlyArray<Capability> => [])

/**
 * Stack one plugin layer on the layers below it, as the plugin graph
 * activates them: `next` is built over everything `base` provides; the two
 * Capabilities arrays concatenate, base first (activateGraph's order); any
 * other service of `next` wins.
 *
 * ```ts
 * const plugins = CapabilitiesLive(host).pipe(
 *   stackPlugins(MemoryLogLive()),
 *   stackPlugins(MemoryWindowLive()),   // + the recall tool
 *   stackPlugins(ToolDiscoveryLive()),  // registry over [host, recall]; + the catalogue
 * )
 * ```
 *
 * Capabilities is a multi-provider key. `Layer.merge`/`Layer.mergeAll`
 * keep one array and silently drop the other layer's tools, skills and
 * sections, and a layer merged beside another cannot see what it
 * contributes: never merge layers that contribute; stack them.
 */
export const stackPlugins = <A2, E2, R2>(next: Layer.Layer<A2, E2, R2>) =>
  <A1, E1, R1>(base: Layer.Layer<A1, E1, R1>): Layer.Layer<A1 | A2, E1 | E2, R1 | Exclude<R2, A1>> =>
    Layer.effectContext(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const lower = yield* Layer.buildWithScope(base, scope)
      const upper = yield* Layer.buildWithScope(next, scope).pipe(Effect.provide(lower))
      const merged = Context.merge(lower, upper)
      const contributes = lower.mapUnsafe.has(Capabilities.key) || upper.mapUnsafe.has(Capabilities.key)
      return contributes
        ? Context.makeUnsafe<A1 | A2>(new Map([...merged.mapUnsafe, [Capabilities.key, [...capabilitiesOf(lower), ...capabilitiesOf(upper)]]]))
        : merged
    }))
