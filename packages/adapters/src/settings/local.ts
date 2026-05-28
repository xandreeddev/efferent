import { Config, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  DefaultSettings,
  FileSystem,
  Settings,
  SettingsStore,
} from "@agent/core"
import { join } from "node:path"

export const LocalSettingsStoreLive = Layer.effect(
  SettingsStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const stateRef = yield* Ref.make<Settings>(DefaultSettings)
    const activeCwdRef = yield* Ref.make("")

    const configPath = (dir: string) => join(dir, ".agent", "config.json")

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

          // `AGENT_MODEL` env seeds the model when no config.json pins one;
          // an explicit `/model` choice (persisted to config.json) wins.
          const envModel = Option.getOrUndefined(
            yield* Config.option(Config.string("AGENT_MODEL")).pipe(
              Effect.orElseSucceed(() => Option.none<string>()),
            ),
          )

          const merged: Settings = {
            allowBash: localConfig?.allowBash ?? homeConfig?.allowBash ?? DefaultSettings.allowBash,
            maxSteps: localConfig?.maxSteps ?? homeConfig?.maxSteps ?? DefaultSettings.maxSteps,
            editorMode: localConfig?.editorMode ?? homeConfig?.editorMode ?? DefaultSettings.editorMode,
            model: localConfig?.model ?? homeConfig?.model ?? envModel ?? DefaultSettings.model,
          }

          yield* Ref.set(stateRef, merged)
          return merged
        }),
    })
  }),
)
