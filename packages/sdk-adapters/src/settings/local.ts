import { Config, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  DefaultSettings,
  FileSystem,
  Settings,
  SettingsStore,
} from "@efferent/sdk-core"
import { join } from "node:path"

export const LocalSettingsStoreLive = Layer.effect(
  SettingsStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const stateRef = yield* Ref.make<Settings>(DefaultSettings)
    const activeCwdRef = yield* Ref.make("")

    const configPath = (dir: string) => join(dir, ".efferent", "config.json")

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
      get: () => Ref.get(stateRef),

      update: (f) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(stateRef)
          const next = f(current)
          yield* Ref.set(stateRef, next)

          const activeCwd = yield* Ref.get(activeCwdRef)
          if (activeCwd) {
            const p = configPath(activeCwd)
            yield* fs.write(p, JSON.stringify(next, null, 2)).pipe(
              Effect.catchAll((err) =>
                Effect.logWarning(`Failed to persist settings to ${p}: ${String(err)}`),
              ),
            )
          }
          return next
        }),

      load: (cwd: string, homeDir: string) =>
        Effect.gen(function* () {
          yield* Ref.set(activeCwdRef, cwd)
          const homeConfig = yield* loadFromFile(configPath(homeDir))
          const localConfig = yield* loadFromFile(configPath(cwd))

          // `EFFERENT_MODEL` env seeds the model when no config.json pins one;
          // an explicit `/model` choice (persisted to config.json) wins. The
          // provider-aware default for a freshly logged-in provider is applied
          // by the driver (it knows which providers have a credential), so the
          // fallback here is just the static default.
          const envModel = Option.getOrUndefined(
            yield* Config.option(Config.string("EFFERENT_MODEL")).pipe(
              Effect.orElseSucceed(() => Option.none<string>()),
            ),
          )

          // GENERIC merge — every Settings key, workspace > home > defaults
          // (the env model slots between home and the static default). The old
          // hand-enumerated merge silently DROPPED any field it forgot
          // (approvedBashRules, theme, subAgentTokenBudget, …): the field
          // loaded as absent, and the next `update()` rewrote config.json
          // without it — `:set` anything and unrelated settings vanished.
          // (`dbUrl` needs no special case here: EFFERENT_DB_URL env
          // precedence is handled at the store selector, migrator.ts.)
          const defined = (o: object | undefined): Partial<Settings> =>
            o === undefined
              ? {}
              : (Object.fromEntries(
                  Object.entries(o).filter(([, v]) => v !== undefined),
                ) as Partial<Settings>)
          const merged: Settings = {
            ...DefaultSettings,
            ...(envModel !== undefined ? { model: envModel } : {}),
            ...defined(homeConfig),
            ...defined(localConfig),
          }

          yield* Ref.set(stateRef, merged)
          return merged
        }),
    })
  }),
)
