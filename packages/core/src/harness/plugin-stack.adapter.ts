import { Context, Effect, Layer, Option } from "effect"
import { Contributions } from "../ports/contribution.port.js"
import type { Contribution } from "../ports/contribution.port.js"

/** The host's own bundles as a layer: the bottom of a plugin stack (see `stackPlugins`). */
export const ContributionsLive = (...bundles: ReadonlyArray<Contribution>): Layer.Layer<Contributions> =>
  Layer.succeed(Contributions, bundles)

const contributionsOf = (context: Context.Context<never>): ReadonlyArray<Contribution> =>
  Option.getOrElse(Context.getOption(context, Contributions), (): ReadonlyArray<Contribution> => [])

/**
 * Stack one plugin layer on the layers below it, as the plugin graph
 * activates them: `next` is built over everything `base` provides; the two
 * Contributions arrays concatenate, base first (activateGraph's order); any
 * other service of `next` wins.
 *
 * ```ts
 * const plugins = ContributionsLive(host).pipe(
 *   stackPlugins(MemoryLogLive()),
 *   stackPlugins(MemoryWindowLive()),   // + the recall tool
 *   stackPlugins(ToolDiscoveryLive()),  // registry over [host, recall]; + the catalogue
 * )
 * ```
 *
 * Contributions is a multi-provider key. `Layer.merge`/`Layer.mergeAll`
 * keep one array and silently drop the other layer's tools, skills and
 * sections, and a layer merged beside another cannot see what it
 * contributes: never merge layers that contribute; stack them.
 */
export const stackPlugins = <A2, E2, R2>(next: Layer.Layer<A2, E2, R2>) =>
  <A1, E1, R1>(base: Layer.Layer<A1, E1, R1>): Layer.Layer<A1 | A2, E1 | E2, R1 | Exclude<R2, A1>> =>
    Layer.scopedContext(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const lower = yield* Layer.buildWithScope(base, scope)
      const upper = yield* Layer.buildWithScope(next, scope).pipe(Effect.provide(lower))
      const merged = Context.merge(lower, upper)
      const contributes = lower.unsafeMap.has(Contributions.key) || upper.unsafeMap.has(Contributions.key)
      return contributes
        ? Context.unsafeMake<A1 | A2>(new Map([...merged.unsafeMap, [Contributions.key, [...contributionsOf(lower), ...contributionsOf(upper)]]]))
        : merged
    }))
