import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Option, Schema } from "effect"
import { HarnessConfig, HarnessError } from "@xandreed/core"
import type { Plugin, PluginEntry } from "@xandreed/core"

export interface ConfigSource {
  readonly path: string
  readonly config: HarnessConfig
  readonly plugins?: ReadonlyArray<Plugin>
}

const mergeEntries = (left: ReadonlyArray<PluginEntry>, right: ReadonlyArray<PluginEntry>): ReadonlyArray<PluginEntry> =>
  right.reduce((entries, incoming) => {
    const old = entries.find((entry) => entry.id === incoming.id)
    const next = old === undefined || old.use !== incoming.use ? incoming : {
      ...old, ...incoming, options: { ...old.options, ...incoming.options },
    }
    return old === undefined ? [...entries, next] : entries.map((entry) => entry.id === incoming.id ? next : entry)
  }, left)

export const mergeConfig = (base: HarnessConfig, overlay: HarnessConfig): HarnessConfig => ({
  ...base, ...overlay,
  plugins: mergeEntries(base.plugins ?? [], overlay.plugins ?? []),
  bindings: { ...base.bindings, ...overlay.bindings },
  profiles: { ...base.profiles, ...overlay.profiles },
})

export const decodeConfig = (input: unknown, source: string): Effect.Effect<HarnessConfig, HarnessError> =>
  Schema.decodeUnknown(HarnessConfig)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new HarnessError({ code: "config.invalid", message: `${source}: ${String(error)}` })),
  )

const io = <A>(action: () => Promise<A>, label: string) => Effect.tryPromise({
  try: action, catch: (error) => new HarnessError({ code: "config.io", message: `${label}: ${String(error)}` }),
})

const exists = (path: string) => Effect.tryPromise({ try: () => access(path), catch: () => false }).pipe(
  Effect.as(true), Effect.orElseSucceed(() => false),
)

const readJson = (path: string) => io(() => readFile(path, "utf8"), path).pipe(
  Effect.flatMap((text) => Schema.decodeUnknown(Schema.parseJson(HarnessConfig))(text, { onExcessProperty: "error" })),
  Effect.mapError((error) => new HarnessError({ code: "config.invalid", message: `${path}: ${String(error)}` })),
)

const readBase = (directory: string): Effect.Effect<Option.Option<ConfigSource>, HarnessError> => Effect.gen(function* () {
  const json = join(directory, "efferent.config.json")
  const ts = join(directory, "efferent.config.ts")
  const found = yield* Effect.filter([json, ts], exists)
  if (found.length > 1) return yield* Effect.fail(new HarnessError({ code: "config.ambiguous", message: `Choose one base configuration in ${directory}: JSON or TypeScript` }))
  const path = found[0]
  if (path === undefined) return Option.none()
  if (!path.endsWith(".ts")) return Option.some({ path, config: yield* readJson(path) })
  const module = yield* io(() => import(`${pathToFileURL(path).href}?revision=${Date.now()}`), path)
  const config = yield* decodeConfig(module.default, path)
  const plugins: unknown = module.plugins ?? []
  if (!Array.isArray(plugins) || plugins.some((value: unknown) => typeof value !== "object" || value === null || !("build" in value) || typeof value.build !== "function" || !("id" in value) || typeof value.id !== "string")) {
    return yield* Effect.fail(new HarnessError({ code: "config.plugins", message: `${path}: plugins must be an array of definePlugin definitions` }))
  }
  return Option.some({ path, config, plugins: plugins as ReadonlyArray<Plugin> })
})

export const loadConfig = (options: {
  readonly workspace: string
  readonly home: string
  readonly preset: HarnessConfig
  readonly profile?: string
  readonly invocation?: HarnessConfig
}) => Effect.gen(function* () {
  const base = yield* Effect.forEach([join(options.home, ".efferent"), options.workspace], readBase)
  const sources = base.flatMap(Option.toArray)
  const combined = sources.reduce((config, source) => mergeConfig(config, source.config), options.preset)
  const profileName = options.profile ?? combined.profile ?? "smith"
  const profile = combined.profiles?.[profileName]
  if (profile === undefined && profileName !== "smith") {
    return yield* Effect.fail(new HarnessError({ code: "config.profile", message: `Unknown profile: ${profileName}` }))
  }
  const selected = profile === undefined ? combined : mergeConfig(combined, { version: 1, ...profile })
  const overridesPath = join(options.workspace, ".efferent", "overrides.json")
  const override = (yield* exists(overridesPath)) ? yield* readJson(overridesPath) : { version: 1 as const }
  const allSources = [...sources, { path: `profile:${profileName}`, config: { version: 1 as const, ...profile } }, { path: overridesPath, config: override }]
  const config = mergeConfig(mergeConfig(selected, override), options.invocation ?? { version: 1 })
  return { config: { ...config, profile: profileName }, sources: allSources.map(({ path, config }) => ({ path, config })), plugins: sources.flatMap((source) => source.plugins ?? []) }
})

export const writeConfig = (path: string, config: HarnessConfig) => decodeConfig(config, path).pipe(
  Effect.flatMap((validated) => io(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }, path)),
)

export const redact = (value: unknown): unknown => Array.isArray(value)
  ? value.map(redact)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|password|token|api.?key|credential/i.test(key) ? "[redacted]" : redact(item)]))
    : value
