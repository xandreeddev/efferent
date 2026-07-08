import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { EngineSettings, SettingsError, SettingsStore } from "@xandreed/engine"
import type { ModelRole } from "@xandreed/engine"

/**
 * Settings from the SAME `config.json` files the previous line writes —
 * global `~/.efferent/config.json` merged with local `<cwd>/.efferent/
 * config.json`, local-over-global per key. The engine reads only the model
 * roles; every other key in the file is preserved untouched on write.
 */

const configPaths = (cwd: string, home: string): ReadonlyArray<string> => [
  join(home, ".efferent", "config.json"),
  join(cwd, ".efferent", "config.json"),
]

const readConfig = (path: string): Effect.Effect<Record<string, unknown>> =>
  Effect.tryPromise({ try: () => readFile(path, "utf-8"), catch: () => "missing" as const }).pipe(
    Effect.map((text) => {
      const parsed = Effect.runSync(
        Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => ({}) }).pipe(
          Effect.orElseSucceed(() => ({})),
        ),
      )
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {}
    }),
    Effect.orElseSucceed(() => ({})),
  )

const asString = (value: unknown): Option.Option<string> =>
  typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none()

export const LocalSettingsStoreLive = (cwd: string, home: string) =>
  Layer.succeed(SettingsStore, {
    load: Effect.gen(function* () {
      const configs = yield* Effect.forEach(configPaths(cwd, home), readConfig)
      const merged = configs.reduce((acc, c) => ({ ...acc, ...c }), {})
      return new EngineSettings({
        model: asString(merged["model"]),
        codeModel: asString(merged["codeModel"]),
        fastModel: asString(merged["fastModel"]),
      })
    }),
    setRole: (role: ModelRole, selection: Option.Option<string>) =>
      Effect.gen(function* () {
        const path = join(cwd, ".efferent", "config.json")
        const key = ROLE_KEYS[role]
        const current = yield* readConfig(path)
        // Some = write the key; None = drop it (the role falls back to its
        // default). Every other key in the file is preserved untouched.
        const next = Option.match(selection, {
          onNone: () =>
            Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
          onSome: (value) => ({ ...current, [key]: value }),
        })
        yield* writeConfigAtomic(path, next)
      }),
  })

const ROLE_KEYS: Record<ModelRole, string> = {
  general: "model",
  code: "codeModel",
  fast: "fastModel",
}

const writeConfigAtomic = (
  path: string,
  config: Record<string, unknown>,
): Effect.Effect<void, SettingsError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}`
      await writeFile(tmp, JSON.stringify(config, null, 2), "utf-8")
      await rename(tmp, path)
    },
    catch: (e) => new SettingsError({ message: `config.json write failed: ${String(e)}` }),
  })
