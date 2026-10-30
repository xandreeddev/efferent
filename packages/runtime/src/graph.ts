import { Array as Arr, Clock, ConfigProvider, Console, Context, Effect, Metric, Option, Order, Predicate, Random, References, Scheduler, Schema, Scope, Tracer } from "effect"
import { createHash } from "node:crypto"
import { CurrentTraceContent, HarnessError, mergeOptions, PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "@xandreed/core"
import type { HarnessConfig, Plugin, PluginEntry } from "@xandreed/core"

export interface PluginNode {
  readonly entry: PluginEntry
  readonly plugin: Plugin
  readonly options: Readonly<Record<string, unknown>>
}

export interface PluginGraph {
  readonly nodes: ReadonlyArray<PluginNode>
  readonly providers: Readonly<Record<string, string>>
  readonly config: HarnessConfig
}

const invalid = (message: string) => Effect.fail(new HarnessError({ code: "config.graph", message }))
/** Version 1 plugins predate capabilities and optional services. */
const contributes = (node: PluginNode): ReadonlyArray<string> => node.plugin.contributes ?? []
const optional = (node: PluginNode): ReadonlyArray<string> => node.plugin.optional ?? []
/**
 * Whether a config still carries a profile selection (`profile`, `profiles`):
 * the host folds the selected profile into the config before resolving it.
 * `HarnessConfig` names neither key, but a config object a host built or
 * read itself may still hold one.
 */
const carriesProfiles = (config: HarnessConfig): boolean =>
  (["profile", "profiles"] as const).some((key) => Predicate.hasProperty(config, key) && config[key] !== undefined)

export const resolveGraph: (
  config: HarnessConfig,
  plugins: ReadonlyArray<Plugin>,
  external?: ReadonlyArray<string>,
) => Effect.Effect<PluginGraph, HarnessError> = Effect.fnUntraced(function* (config, plugins, external = []) {
  const duplicatePlugin = plugins.find((plugin, index) => plugins.findIndex((other) => other.id === plugin.id) !== index)
  if (duplicatePlugin !== undefined) return yield* invalid(`duplicate plugin definition: ${duplicatePlugin.id}`)
  if (carriesProfiles(config)) {
    return yield* Effect.fail(new HarnessError({
      code: "config.profile",
      message: "profiles are not resolved by the plugin graph: fold the selected profile's plugins, bindings and system into the config, and leave profile and profiles out",
    }))
  }
  const entries = (config.plugins ?? []).filter((entry) => entry.enabled !== false)
  const duplicate = entries.find((entry, index) => entries.findIndex((other) => other.id === entry.id) !== index)
  if (duplicate !== undefined) return yield* invalid(`duplicate plugin instance: ${duplicate.id}`)
  const nodes = yield* Effect.forEach(entries, (entry) => Effect.gen(function* () {
    const plugin = plugins.find((candidate) => candidate.id === entry.use)
    if (plugin === undefined) return yield* invalid(`plugin ${entry.use} is not installed (instance ${entry.id})`)
    if (!SUPPORTED_PLUGIN_API_VERSIONS.includes(plugin.apiVersion)) return yield* invalid(`${entry.id}: plugin API ${plugin.apiVersion} is incompatible with ${PLUGIN_API_VERSION}`)
    const options = mergeOptions(plugin.schema, plugin.defaults, entry.options ?? {})
    yield* Schema.decodeUnknownEffect(plugin.schema)(options, { onExcessProperty: "error", reportInput: true }).pipe(
      Effect.mapError((error) => new HarnessError({ code: "config.options", plugin: entry.id, message: error.message, cause: error })),
    )
    return { entry, plugin, options }
  }), { concurrency: 1 })
  const keys = [...new Set(nodes.flatMap((node) => node.plugin.provides))]
  const providers = Object.fromEntries(yield* Effect.forEach(keys, (key) => Effect.gen(function* () {
    const candidates = nodes.filter((node) => node.plugin.provides.includes(key))
    const binding = config.bindings?.[key]
    if (binding !== undefined && !candidates.some((node) => node.entry.id === binding)) {
      return yield* invalid(`${key}: binding ${binding} does not provide this service`)
    }
    if (candidates.length > 1 && binding === undefined) {
      return yield* invalid(`${key}: choose a binding from ${candidates.map((node) => node.entry.id).join(", ")}`)
    }
    return [key, binding ?? candidates[0]!.entry.id] as const
  }), { concurrency: 1 }))
  yield* Effect.forEach(Object.keys(config.bindings ?? {}), (key) =>
    keys.includes(key) ? Effect.void : invalid(`binding references an unavailable service: ${key}`), { concurrency: 1 })
  const contributors = (key: string, except: PluginNode): ReadonlyArray<PluginNode> =>
    nodes.filter((node) => node !== except && contributes(node).includes(key))
  const contributed = new Set(nodes.flatMap(contributes))
  yield* Effect.forEach(nodes, (node) => Effect.forEach([...node.plugin.requires, ...optional(node)], (key) => {
    const provider = nodes.find((candidate) => candidate.entry.id === providers[key])
    const isCapability = contributed.has(key)
    if (provider !== undefined && isCapability) return invalid(`${key} is both provided and contributed`)
    if (provider === undefined && !isCapability && !external.includes(key) && node.plugin.requires.includes(key)) {
      return invalid(`${node.entry.id} requires missing service ${key}`)
    }
    const sources = isCapability ? contributors(key, node) : provider === undefined ? [] : [provider]
    if (node.plugin.scope === "runtime" && sources.some((source) => source.plugin.scope === "session")) {
      return invalid(`${node.entry.id}: runtime plugins cannot depend on session service ${key}`)
    }
    return Effect.void
  }, { concurrency: 1 }), { concurrency: 1 })
  const order = (remaining: ReadonlyArray<PluginNode>, sorted: ReadonlyArray<PluginNode>): Effect.Effect<ReadonlyArray<PluginNode>, HarnessError> => {
    if (remaining.length === 0) return Effect.succeed(sorted)
    const ready = remaining.filter((node) => [...node.plugin.requires, ...optional(node)].every((key) =>
      external.includes(key) ||
      (contributed.has(key)
        ? contributors(key, node).every((source) => sorted.includes(source))
        : providers[key] === undefined ? !node.plugin.requires.includes(key) : sorted.some((candidate) => candidate.entry.id === providers[key]))))
    if (ready.length === 0) return invalid(`dependency cycle: ${remaining.map((node) => node.entry.id).join(" → ")}`)
    return Effect.suspend(() => order(remaining.filter((node) => !ready.includes(node)), [...sorted, ...ready]))
  }
  return { nodes: yield* order(nodes, []), providers, config }
})

const contributedKeys = (graph: PluginGraph): ReadonlySet<string> => new Set(graph.nodes.flatMap(contributes))
const asArray = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []

/**
 * What a fiber runs with that is not a service: Effect's settings (logging,
 * tracing, clock, random, console, scheduler, metrics, configuration), the
 * current span and whether spans may carry content.
 */
const fiberSettings: ReadonlySet<string> = new Set([
  ...Object.values(References), Tracer.ParentSpan, Tracer.Tracer, Tracer.CurrentTraceLevel, Tracer.DisablePropagation,
  Clock.Clock, Random.Random, Console.Console, Scheduler.Scheduler, Scheduler.MaxOpsBeforeYield, Scheduler.PreventSchedulerYield,
  Metric.MetricRegistry, Metric.CurrentMetricAttributes, ConfigProvider.ConfigProvider, CurrentTraceContent,
].map((key) => key.key))

/** The fiber's settings alone: the services around an activation do not reach the layers it builds. */
const settingsOnly = (context: Context.Context<never>): Context.Context<never> =>
  Context.makeUnsafe<never>(new Map([...context.mapUnsafe].filter(([key]) => fiberSettings.has(key))))

/**
 * Every activation is scoped. A failed staging scope is disposed by its
 * caller. A plugin's layer is built with the services it declares (required
 * and optional) and its scope, over the fiber's settings: a service the
 * activation's caller has, in `services` or around it, is not there unless
 * the plugin declares it.
 */
export const activateGraph = (
  graph: PluginGraph,
  lifetime: "runtime" | "session",
  services: Context.Context<never>,
  scope: Scope.Scope,
): Effect.Effect<Context.Context<never>, HarnessError> => Effect.reduce(
  graph.nodes.filter((node) => node.plugin.scope === lifetime), () => services,
  (context, node) => Effect.gen(function* () {
    const dependencies = Context.makeUnsafe<never>(new Map([...node.plugin.requires, ...optional(node)].flatMap((key) =>
      context.mapUnsafe.has(key) ? [[key, context.mapUnsafe.get(key)] as const]
        : contributedKeys(graph).has(key) ? [[key, []] as const] : [])))
    const built = yield* node.plugin.build(node.options, dependencies).pipe(Scope.provide(scope), Effect.updateContext(settingsOnly))
    const missing = [...node.plugin.provides, ...contributes(node)].filter((key) => !built.mapUnsafe.has(key))
    if (missing.length > 0) return yield* invalid(`${node.entry.id} did not provide declared services: ${missing.join(", ")}`)
    const invalidCapability = contributes(node).find((key) => !Array.isArray(built.mapUnsafe.get(key)))
    if (invalidCapability !== undefined) return yield* invalid(`${node.entry.id} contributed a non-array value to ${invalidCapability}`)
    const selected = new Map([
      ...node.plugin.provides.flatMap((key) => graph.providers[key] === node.entry.id ? [[key, built.mapUnsafe.get(key)] as const] : []),
      ...contributes(node).map((key) => [key, [...asArray(context.mapUnsafe.get(key)), ...asArray(built.mapUnsafe.get(key))]] as const),
    ])
    return Context.merge(context, Context.makeUnsafe<never>(selected))
  }),
)

/**
 * A value's JSON (as `JSON.stringify` writes it, `toJSON` applied) with
 * every object's keys in code-unit order, so it does not depend on the order
 * they were written in; none for what JSON leaves out (undefined, a function).
 */
const canonicalJson = (value: unknown): Option.Option<string> => {
  const json: unknown = typeof value === "object" && value !== null && "toJSON" in value && typeof value.toJSON === "function" ? value.toJSON() : value
  if (Array.isArray(json)) return Option.some(`[${json.map((item) => Option.getOrElse(canonicalJson(item), () => "null")).join(",")}]`)
  if (typeof json === "object" && json !== null) {
    return Option.some(`{${Arr.sort(Object.keys(json), Order.String).flatMap((key) =>
      Option.toArray(Option.map(canonicalJson(Reflect.get(json, key)), (text) => `${JSON.stringify(key)}:${text}`))).join(",")}}`)
  }
  return Option.fromNullishOr(JSON.stringify(json))
}

/**
 * The graph's identity: its instances (id, plugin, version and options, in
 * graph order), its bindings and, unless only runtime plugins are asked for,
 * the system prompt, hashed as canonical JSON: options written in another
 * key order (JSON or TypeScript) give the same fingerprint.
 */
export const graphFingerprint = (graph: PluginGraph, scope?: "runtime" | "session"): string => {
  const inScope = (node: PluginNode) => scope === undefined || node.plugin.scope === scope
  const identity = {
    nodes: graph.nodes.filter(inScope).map((node) => ({ id: node.entry.id, use: node.plugin.id, version: node.plugin.version, options: node.options })),
    bindings: Object.fromEntries(Object.entries(graph.providers).filter(([, id]) => graph.nodes.some((node) => node.entry.id === id && inScope(node)))),
    ...(scope === "runtime" ? {} : { system: graph.config.system }),
  }
  return createHash("sha256").update(Option.getOrElse(canonicalJson(identity), () => "null")).digest("hex")
}
