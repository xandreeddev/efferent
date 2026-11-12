import { Clock, ConfigProvider, Console, Context, Effect, Layer, Metric, Random, References, Scheduler, Tracer } from "effect"
import type { Scope } from "effect"
import { CurrentPlugin } from "./core.port.js"
import type { PluginFailure } from "./event.entity.js"
import { PluginName } from "./ids.entity.js"
import { PluginRefused } from "./plugin.entity.js"

/**
 * The contracts a plugin declares that it needs: their service keys.
 *
 * @public
 */
export type Contracts = ReadonlyArray<Context.Service.Any>

/**
 * A plugin as an agent's wiring takes it, whatever it needs: its name, the
 * keys of the contracts it declared that it needs, the key of the contract
 * it provides, and `build`, which makes it over services found by key. What
 * a plugin needs is not in this type: it is declared (`requires`) and
 * checked, by key, before anything is built (`planPlugins`).
 *
 * `build` hands the plugin the contracts it declared and nothing else, in
 * the scope it is run in, and gives back the contract it provides: a
 * service its caller has around it, declared or not, does not reach the
 * plugin, only the fiber's settings do (the clock, the tracer, the logger
 * and Effect's other references). Run over services that lack a declared
 * one, it fails with `PluginRefused` before the plugin's `make` starts.
 *
 * @public
 */
export interface PluginOf<Provides = never> {
  readonly name: PluginName
  readonly version?: string
  readonly requires: ReadonlyArray<string>
  readonly provides?: string
  readonly build: (services: Context.Context<never>) => Effect.Effect<Context.Context<Provides>, PluginFailure, Scope.Scope>
}

/**
 * A plugin: an Effect layer with a name. It declares the contracts it
 * needs (`requires`) and the one it provides (`provides`), and its layer's
 * type says the same. Its name is the prefix of the events it writes
 * (`plugin.<name>.`) and the name of the listeners it registers. A plugin a
 * package ships also states its version, the package's.
 *
 * @public
 */
export interface Plugin<Provides, E = never, R = never> {
  readonly name: PluginName
  readonly version?: string
  /** The keys of the contracts it needs, as it declared them. */
  readonly requires: ReadonlyArray<string>
  /** The key of the contract it provides, when it provides one. */
  readonly provides?: string
  readonly layer: Layer.Layer<Provides, E, R>
  /** The layer built over services found by key: see `PluginOf`. */
  readonly build: (services: Context.Context<never>) => Effect.Effect<Context.Context<Provides>, E | PluginRefused, Scope.Scope>
}

/**
 * What a fiber runs with that is no contract: Effect's own settings, each
 * with a default (logging, tracing, the clock, randomness, the console, the
 * scheduler, metrics, configuration), and the plugin whose setup is running.
 */
const fiberSettings: ReadonlySet<string> = new Set([
  ...Object.values(References), Tracer.ParentSpan, Tracer.Tracer, Tracer.CurrentTraceLevel, Tracer.DisablePropagation,
  Clock.Clock, Random.Random, Console.Console, Scheduler.Scheduler, Scheduler.MaxOpsBeforeYield, Scheduler.PreventSchedulerYield,
  Metric.MetricRegistry, Metric.CurrentMetricAttributes, ConfigProvider.ConfigProvider, CurrentPlugin,
].map((key) => key.key))

/** The fiber's settings alone: a service that whoever builds a plugin has around it does not reach the plugin. */
const settingsOf = (around: Context.Context<never>): Context.Context<never> =>
  Context.makeUnsafe<never>(new Map(Array.from(around.mapUnsafe).filter(([key]) => fiberSettings.has(key))))

/** What a plugin is defined from, whatever it provides. */
interface PluginSpec<Requires extends Contracts, E, S> {
  readonly name: string
  /** The version of the package that ships the plugin; a plugin written by a host or a test states none. */
  readonly version?: string
  /** The contracts `make` may use: every one it needs, an empty list when it needs none. */
  readonly requires: Requires
  /** Makes the plugin. It may use the contracts `requires` lists and the scope it runs in, and nothing else. */
  readonly make: Effect.Effect<S, E, Context.Service.Identifier<Requires[number]> | Scope.Scope>
}

/**
 * Define a plugin from its name, the contracts it needs, the contract it
 * provides and the effect that makes it.
 *
 * `requires` lists every contract `make` uses: `Core`, `JournalStorage`,
 * `Sessions`, `Memory`, `Loop`, `Settings`, the model's key, or a contract
 * another plugin declares in its own folder. A `make` that uses a contract
 * the list lacks does not compile. A `Context.Reference` needs no
 * declaration, since it has a default. The scope is not declared: `make` runs
 * once, in the plugin's scope, and what it registers with `Core.on` and
 * what it acquires are released when that scope closes. A plugin that only
 * listens leaves `provides` out.
 *
 * Write the list in place, as `requires: [Core, Sessions]`. The compiler
 * checks `make` against the list's own type, so a list built elsewhere and
 * typed loosely (`ReadonlyArray<Context.Service.Any>`, `Contracts`) checks
 * nothing: a `make` that uses a contract such a list lacks compiles, and
 * dies when the agent is defined, since it is handed only what the list
 * holds.
 *
 * @public
 */
export function definePlugin<const Requires extends Contracts, I, S, E>(spec: PluginSpec<Requires, E, S> & { readonly provides: Context.Key<I, S> }): Plugin<I, E, Context.Service.Identifier<Requires[number]>>
export function definePlugin<const Requires extends Contracts, E>(spec: PluginSpec<Requires, E, void>): Plugin<never, E, Context.Service.Identifier<Requires[number]>>
export function definePlugin<const Requires extends Contracts, I, S, E>(spec: PluginSpec<Requires, E, S> & { readonly provides?: Context.Key<I, S> }): Plugin<never, E, Context.Service.Identifier<Requires[number]>> {
  type Needs = Context.Service.Identifier<Requires[number]>
  const name = PluginName.make(spec.name)
  // A Reference has a default and no provider: listing one declares nothing.
  const requires = spec.requires.filter((contract) => !Context.isReference(contract)).map((contract) => contract.key)
  const provided = spec.provides
  const make = Effect.provideService(spec.make, CurrentPlugin, name)
  const layer: Layer.Layer<never, E, Needs> = provided === undefined ? Layer.effectDiscard(make) : Layer.effect(provided, make)

  const build = (services: Context.Context<never>): Effect.Effect<Context.Context<never>, E | PluginRefused, Scope.Scope> => {
    const missing = requires.find((key) => !services.mapUnsafe.has(key))
    if (missing !== undefined) {
      return Effect.fail(new PluginRefused({ reason: "MissingProvider", plugin: name, contract: missing, message: `plugin ${name} requires ${missing}, which the services it was built over lack` }))
    }
    // The declared contracts and nothing else: each was found by its key, so the context is the one `make` asks for.
    const declared = Context.makeUnsafe<Needs>(new Map(requires.map((key) => [key, services.mapUnsafe.get(key)])))
    return Effect.flatMap(Effect.scope, (scope) => Layer.buildWithScope(Layer.fresh(layer), scope).pipe(
      // In place of what the caller runs with, its settings aside: a service around the caller is not the plugin's to find.
      Effect.updateContext((around: Context.Context<never>) => Context.merge(settingsOf(around), declared)),
    )).pipe(
      // What it provides, and nothing of how the layer was built.
      Effect.map((built) => provided === undefined ? Context.empty() : Context.makeUnsafe<never>(new Map([[provided.key, built.mapUnsafe.get(provided.key)]]))),
    )
  }
  const stated = spec.version === undefined ? {} : { version: spec.version }
  return { name, ...stated, requires, ...(provided === undefined ? {} : { provides: provided.key }), layer, build }
}
