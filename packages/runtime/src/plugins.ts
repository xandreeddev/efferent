import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import { HarnessError } from "@xandreed/core"
import type { HarnessConfig, Plugin } from "@xandreed/core"

export const loadPlugins = (config: HarnessConfig, builtins: ReadonlyArray<Plugin>, workspace: string, home: string): Effect.Effect<ReadonlyArray<Plugin>, HarnessError> =>
  Effect.reduce([...new Set((config.plugins ?? []).filter((entry) => entry.enabled !== false).map((entry) => entry.use))], () => builtins, (loaded, use) => {
    if (loaded.some((plugin) => plugin.id === use)) return Effect.succeed(loaded)
    const locate = use.startsWith(".") || use.startsWith("/") ? Effect.succeed(resolve(workspace, use)) : Effect.try(() => createRequire(join(workspace, "package.json")).resolve(use)).pipe(
          Effect.catch(() => Effect.try(() => createRequire(join(home, ".efferent/plugins/package.json")).resolve(use))),
        )
    return locate.pipe(
      Effect.flatMap((path) => Effect.tryPromise(() => import(pathToFileURL(path).href))),
      Effect.map((module) => {
        const value = module.default
        if (value === null || typeof value !== "object" || typeof value.build !== "function" || !Array.isArray(value.requires) || !Array.isArray(value.provides) || typeof value.version !== "string") return { valid: false as const }
        return { valid: true as const, plugin: { ...value, id: use } as Plugin }
      }),
      Effect.mapError((error) => new HarnessError({ code: "plugin.load", plugin: use, message: `Cannot load installed plugin ${use}: ${String(error)}` })),
      Effect.flatMap((result) => result.valid ? Effect.succeed([...loaded, result.plugin]) : Effect.fail(new HarnessError({ code: "plugin.manifest", plugin: use, message: "The module must default-export a definePlugin definition" }))),
    )
  })

/** A plugin's options as one JSON Schema, its definitions inline under `$defs`. */
export const pluginSchema = (plugin: Plugin) => {
  const document = Schema.toJsonSchemaDocument(plugin.schema)
  return Object.keys(document.definitions).length > 0 ? { ...document.schema, $defs: document.definitions } : document.schema
}
