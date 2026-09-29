import { Context, Effect, Schema, Scope } from "effect"
import { createHash } from "node:crypto"
import { HarnessError, PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "@xandreed/core"
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
/** Version 1 plugins predate contributions and optional services. */
const contributes = (node: PluginNode): ReadonlyArray<string> => node.plugin.contributes ?? []
const optional = (node: PluginNode): ReadonlyArray<string> => node.plugin.optional ?? []

export const resolveGraph = (
  config: HarnessConfig,
  plugins: ReadonlyArray<Plugin>,
  external: ReadonlyArray<string> = [],
): Effect.Effect<PluginGraph, HarnessError> => Effect.gen(function* () {
  const duplicatePlugin = plugins.find((plugin, index) => plugins.findIndex((other) => other.id === plugin.id) !== index)
  if (duplicatePlugin !== undefined) return yield* invalid(`duplicate plugin definition: ${duplicatePlugin.id}`)
  const entries = (config.plugins ?? []).filter((entry) => entry.enabled !== false)
  const duplicate = entries.find((entry, index) => entries.findIndex((other) => other.id === entry.id) !== index)
  if (duplicate !== undefined) return yield* invalid(`duplicate plugin instance: ${duplicate.id}`)
  const nodes = yield* Effect.forEach(entries, (entry) => Effect.gen(function* () {
    const plugin = plugins.find((candidate) => candidate.id === entry.use)
    if (plugin === undefined) return yield* invalid(`plugin ${entry.use} is not installed (instance ${entry.id})`)
    if (!SUPPORTED_PLUGIN_API_VERSIONS.includes(plugin.apiVersion)) return yield* invalid(`${entry.id}: plugin API ${plugin.apiVersion} is incompatible with ${PLUGIN_API_VERSION}`)
    const options = { ...plugin.defaults, ...entry.options }
    yield* Schema.decodeUnknownEffect(plugin.schema)(options, { onExcessProperty: "error", reportInput: true }).pipe(
      Effect.mapError((error) => new HarnessError({ code: "config.options", plugin: entry.id, message: String(error) })),
    )
    return { entry, plugin, options }
  }))
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
  })))
  yield* Effect.forEach(Object.keys(config.bindings ?? {}), (key) =>
    keys.includes(key) ? Effect.void : invalid(`binding references an unavailable service: ${key}`))
  const contributors = (key: string, except: PluginNode): ReadonlyArray<PluginNode> =>
    nodes.filter((node) => node !== except && contributes(node).includes(key))
  const contributed = new Set(nodes.flatMap(contributes))
  yield* Effect.forEach(nodes, (node) => Effect.forEach([...node.plugin.requires, ...optional(node)], (key) => {
    const provider = nodes.find((candidate) => candidate.entry.id === providers[key])
    const isContribution = contributed.has(key)
    if (provider !== undefined && isContribution) return invalid(`${key} is both provided and contributed`)
    if (provider === undefined && !isContribution && !external.includes(key) && node.plugin.requires.includes(key)) {
      return invalid(`${node.entry.id} requires missing service ${key}`)
    }
    const sources = isContribution ? contributors(key, node) : provider === undefined ? [] : [provider]
    if (node.plugin.scope === "runtime" && sources.some((source) => source.plugin.scope === "session")) {
      return invalid(`${node.entry.id}: runtime plugins cannot depend on session service ${key}`)
    }
    return Effect.void
  }))
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

/** Every activation is scoped. A failed staging scope is disposed by its caller. */
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
    const built = yield* Scope.provide(node.plugin.build(node.options, dependencies), scope)
    const missing = [...node.plugin.provides, ...contributes(node)].filter((key) => !built.mapUnsafe.has(key))
    if (missing.length > 0) return yield* invalid(`${node.entry.id} did not provide declared services: ${missing.join(", ")}`)
    const invalidContribution = contributes(node).find((key) => !Array.isArray(built.mapUnsafe.get(key)))
    if (invalidContribution !== undefined) return yield* invalid(`${node.entry.id} contributed a non-array value to ${invalidContribution}`)
    const selected = new Map([
      ...node.plugin.provides.flatMap((key) => graph.providers[key] === node.entry.id ? [[key, built.mapUnsafe.get(key)] as const] : []),
      ...contributes(node).map((key) => [key, [...asArray(context.mapUnsafe.get(key)), ...asArray(built.mapUnsafe.get(key))]] as const),
    ])
    return Context.merge(context, Context.makeUnsafe<never>(selected))
  }),
)

export const graphFingerprint = (graph: PluginGraph, scope?: "runtime" | "session"): string =>
  createHash("sha256").update(JSON.stringify({ nodes: graph.nodes.filter((node) => scope === undefined || node.plugin.scope === scope).map((node) => ({
    id: node.entry.id, use: node.plugin.id, version: node.plugin.version, options: node.options,
  })), bindings: Object.fromEntries(Object.entries(graph.providers).filter(([, id]) => scope === undefined || graph.nodes.some((node) => node.entry.id === id && node.plugin.scope === scope))),
    ...(scope === "runtime" ? {} : { system: graph.config.system }) })).digest("hex")
