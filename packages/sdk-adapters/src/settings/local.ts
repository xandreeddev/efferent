import { Config, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  type ConfigScope,
  DefaultSettings,
  FileSystem,
  Settings,
  SettingsStore,
} from "@xandreed/sdk-core"
import { join } from "node:path"
import {
  type ConfigRoots,
  dirForScope,
  ensureLocalGitignore,
  resolveConfigRoots,
} from "../configRoots.js"

/** A per-tier on-disk partial: every Settings key optional and allowed to be
 *  `undefined` (matches `Schema.partial(Settings)`'s decoded shape, which
 *  `Partial<Settings>` doesn't under `exactOptionalPropertyTypes`). */
type SettingsPatch = { [K in keyof Settings]?: Settings[K] | undefined }

/** Drop `undefined`-valued keys so a tier's partial only carries set values
 *  (so a tier's explicit `undefined` can't mask a lower tier, and spreading the
 *  result doesn't widen a required Settings field to include `undefined`). */
const defined = (o: object | undefined): Partial<Settings> =>
  o === undefined
    ? {}
    : (Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<Settings>)

export const LocalSettingsStoreLive = Layer.effect(
  SettingsStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    // On-disk values per tier (partials), the resolved roots, and the optional
    // EFFERENT_MODEL seed. Reads are the merge `defaults < env < global < local`.
    const globalRef = yield* Ref.make<SettingsPatch>({})
    const localRef = yield* Ref.make<SettingsPatch>({})
    const envModelRef = yield* Ref.make<string | undefined>(undefined)
    const rootsRef = yield* Ref.make<ConfigRoots>({ single: false, global: "", local: undefined })

    const cfgFile = (efferentDir: string) => join(efferentDir, "config.json")

    const mergeGlobal = (g: SettingsPatch, env: string | undefined): Settings => ({
      ...DefaultSettings,
      ...(env !== undefined ? { model: env } : {}),
      ...defined(g),
    })
    const mergeAll = (
      g: SettingsPatch,
      l: SettingsPatch,
      env: string | undefined,
    ): Settings => ({ ...mergeGlobal(g, env), ...defined(l) })

    const loadFromFile = (path: string) =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(path)
        if (!exists) return undefined
        const file = yield* fs.read(path)
        let json: unknown
        try {
          json = JSON.parse(file.content)
        } catch (err) {
          yield* Effect.logWarning(`Failed to parse settings JSON at ${path}: ${String(err)}`)
          return undefined
        }
        // A `null` on an optional field is NOT the same as absent to the schema
        // (`Schema.optional(Schema.String)` accepts string|undefined, never null),
        // so a single null — e.g. `codeModel: null`, written by the `:model code`
        // "default (follow general)" option — would fail validation and discard the
        // ENTIRE config, silently dropping every other setting (model, fastModel,
        // approvals…) and falling back to global. Treat a top-level null as "unset"
        // so one cleared field never nukes the rest.
        if (json !== null && typeof json === "object" && !Array.isArray(json)) {
          json = Object.fromEntries(
            Object.entries(json as Record<string, unknown>).filter(([, v]) => v !== null),
          )
        }
        return yield* Schema.decodeUnknown(Schema.partial(Settings))(json).pipe(
          Effect.catchAll((err) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`Failed to validate settings at ${path}: ${String(err)}`)
              return undefined
            }),
          ),
        )
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    return SettingsStore.of({
      get: () =>
        Effect.gen(function* () {
          const env = yield* Ref.get(envModelRef)
          return mergeAll(yield* Ref.get(globalRef), yield* Ref.get(localRef), env)
        }),

      global: () =>
        Effect.gen(function* () {
          const env = yield* Ref.get(envModelRef)
          return mergeGlobal(yield* Ref.get(globalRef), env)
        }),

      update: (f, scope: ConfigScope = "local") =>
        Effect.gen(function* () {
          const roots = yield* Ref.get(rootsRef)
          const env = yield* Ref.get(envModelRef)
          const g = yield* Ref.get(globalRef)
          const l = yield* Ref.get(localRef)
          const prev = mergeAll(g, l, env)
          const next = f(prev)

          // Persist only the keys f actually changed, into the chosen tier's
          // partial — so a global write can't clobber a local override and a
          // local write keeps the global baseline intact. (Single-source mode
          // has one tier; scope is ignored.)
          const writesGlobal = roots.single || scope === "global"
          const tier = { ...(writesGlobal ? g : l) }
          const keys = new Set<keyof Settings>([
            ...(Object.keys(prev) as (keyof Settings)[]),
            ...(Object.keys(next) as (keyof Settings)[]),
          ])
          for (const k of keys) {
            if (next[k] === prev[k]) continue
            if (next[k] === undefined) delete tier[k]
            else (tier as Record<string, unknown>)[k] = next[k]
          }
          if (writesGlobal) yield* Ref.set(globalRef, tier)
          else yield* Ref.set(localRef, tier)

          const dir = dirForScope(roots, scope)
          const p = cfgFile(dir)
          yield* fs.write(p, `${JSON.stringify(tier, null, 2)}\n`).pipe(
            Effect.catchAll((err) =>
              Effect.logWarning(`Failed to persist settings to ${p}: ${String(err)}`),
            ),
          )
          if (!roots.single && !writesGlobal) {
            yield* Effect.sync(() => ensureLocalGitignore(dir))
          }

          // Re-merge from the tiers (NOT `next`): a global write to a
          // locally-overridden key must leave the effective value as the local one.
          return mergeAll(yield* Ref.get(globalRef), yield* Ref.get(localRef), env)
        }),

      load: (cwd: string, homeDir?: string) =>
        Effect.gen(function* () {
          // `EFFERENT_HOME` set → single flat source; else global (homeDir) +
          // local <cwd>/.efferent, merged local-over-global (`resolveConfigRoots`).
          const roots = resolveConfigRoots(cwd, homeDir)
          yield* Ref.set(rootsRef, roots)

          const g = (yield* loadFromFile(cfgFile(roots.global))) ?? {}
          const l =
            roots.single || roots.local === undefined
              ? {}
              : ((yield* loadFromFile(cfgFile(roots.local))) ?? {})

          // `EFFERENT_MODEL` seeds the model when no config pins one; an explicit
          // `/model` choice (persisted) wins. Slots between defaults and global.
          const envModel = Option.getOrUndefined(
            yield* Config.option(Config.string("EFFERENT_MODEL")).pipe(
              Effect.orElseSucceed(() => Option.none<string>()),
            ),
          )

          yield* Ref.set(globalRef, g)
          yield* Ref.set(localRef, l)
          yield* Ref.set(envModelRef, envModel)
          return mergeAll(g, l, envModel)
        }),
    })
  }),
)
