import { Context, Effect, Schema, Scope } from "effect"
import { createHash } from "node:crypto"
import { HarnessError, PLUGIN_API_VERSION } from "@xandreed/core"
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
    if (plugin.apiVersion !== PLUGIN_API_VERSION) return yield* invalid(`${entry.id}: plugin API ${plugin.apiVersion} is incompatible with ${PLUGIN_API_VERSION}`)
    const options = { ...plugin.defaults, ...entry.options }
    yield* Schema.decodeUnknown(plugin.schema)(options, { onExcessProperty: "error" }).pipe(
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
  yield* Effect.forEach(nodes, (node) => Effect.forEach(node.plugin.requires, (key) => {
    const provider = nodes.find((candidate) => candidate.entry.id === providers[key])
    if (provider === undefined && !external.includes(key)) return invalid(`${node.entry.id} requires missing service ${key}`)
    if (node.plugin.scope === "runtime" && provider?.plugin.scope === "session") {
      return invalid(`${node.entry.id}: runtime plugins cannot depend on session service ${key}`)
    }
    return Effect.void
  }))
  const order = (remaining: ReadonlyArray<PluginNode>, sorted: ReadonlyArray<PluginNode>): Effect.Effect<ReadonlyArray<PluginNode>, HarnessError> => {
    if (remaining.length === 0) return Effect.succeed(sorted)
    const ready = remaining.filter((node) => node.plugin.requires.every((key) =>
      external.includes(key) || sorted.some((candidate) => candidate.entry.id === providers[key])))
    if (ready.length === 0) return invalid(`dependency cycle: ${remaining.map((node) => node.entry.id).join(" → ")}`)
    return Effect.suspend(() => order(remaining.filter((node) => !ready.includes(node)), [...sorted, ...ready]))
  }
  return { nodes: yield* order(nodes, []), providers, config }
})

/** Every activation is scoped. A failed staging scope is disposed by its caller. */
export const activateGraph = (
  graph: PluginGraph,
  lifetime: "runtime" | "session",
  services: Context.Context<never>,
  scope: Scope.Scope,
): Effect.Effect<Context.Context<never>, HarnessError> => Effect.reduce(
  graph.nodes.filter((node) => node.plugin.scope === lifetime), services,
  (context, node) => Effect.gen(function* () {
    const dependencies = Context.unsafeMake<never>(new Map(node.plugin.requires.flatMap((key) =>
      context.unsafeMap.has(key) ? [[key, context.unsafeMap.get(key)] as const] : [])))
    const built = yield* Scope.extend(node.plugin.build(node.options, dependencies), scope)
    const missing = node.plugin.provides.filter((key) => !built.unsafeMap.has(key))
    if (missing.length > 0) return yield* invalid(`${node.entry.id} did not provide declared services: ${missing.join(", ")}`)
    const selected = new Map(node.plugin.provides.flatMap((key) =>
      graph.providers[key] === node.entry.id ? [[key, built.unsafeMap.get(key)] as const] : []))
    return Context.merge(context, Context.unsafeMake<never>(selected))
  }),
)

export const graphFingerprint = (graph: PluginGraph, scope?: "runtime" | "session"): string =>
  createHash("sha256").update(JSON.stringify({ nodes: graph.nodes.filter((node) => scope === undefined || node.plugin.scope === scope).map((node) => ({
    id: node.entry.id, use: node.plugin.id, version: node.plugin.version, options: node.options,
  })), bindings: Object.fromEntries(Object.entries(graph.providers).filter(([, id]) => scope === undefined || graph.nodes.some((node) => node.entry.id === id && node.plugin.scope === scope))),
    ...(scope === "runtime" ? {} : { system: graph.config.system }) })).digest("hex")
