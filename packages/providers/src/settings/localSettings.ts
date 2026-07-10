import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect, Layer, Option } from "effect"
import {
  asJsonRecord,
  EngineSettings,
  parseJsonWarn,
  parseModelSelection,
  SettingsError,
  SettingsStore,
} from "@xandreed/engine"
import type { ModelRole, SettingsKey } from "@xandreed/engine"

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
    // Corrupt ≠ absent: a malformed config warns (defaults with zero signal
    // read as "my settings vanished"); a missing file is just empty.
    Effect.flatMap((text) => parseJsonWarn(text, path)),
    Effect.map(asJsonRecord),
    Effect.orElseSucceed(() => ({})),
  )

const asString = (value: unknown): Option.Option<string> =>
  typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none()

const asBoolean = (value: unknown): Option.Option<boolean> =>
  typeof value === "boolean" ? Option.some(value) : Option.none()

const asNumber = (value: unknown): Option.Option<number> =>
  typeof value === "number" && Number.isFinite(value) ? Option.some(value) : Option.none()

/**
 * Per-key validation for the keyed setter — the config value is COERCED
 * from its string form (`:settings` sends text), so an unparseable value is
 * rejected here rather than written and silently ignored on load.
 */
const coerceSettingValue = (
  key: SettingsKey,
  raw: string,
): Effect.Effect<unknown, SettingsError> => {
  if (key === "fallbackModel") {
    return Option.match(parseModelSelection(raw), {
      onNone: () =>
        Effect.fail(
          new SettingsError({
            message: `fallbackModel must be "<provider>:<modelId>" — got "${raw}"`,
          }),
        ),
      onSome: () => Effect.succeed(raw as unknown),
    })
  }
  if (key === "sandbox" || key === "viMode") {
    if (raw === "true" || raw === "on") return Effect.succeed(true as unknown)
    if (raw === "false" || raw === "off") return Effect.succeed(false as unknown)
    return Effect.fail(
      new SettingsError({ message: `${key} must be true/false — got "${raw}"` }),
    )
  }
  // maxAttempts / budgetMillis: positive integers (foundry re-validates the
  // forge bounds when the Spec is built).
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 1
    ? Effect.succeed(parsed as unknown)
    : Effect.fail(
        new SettingsError({ message: `${key} must be a positive integer — got "${raw}"` }),
      )
}

/** Write (or drop) one key in the LOCAL config, every other key preserved. */
const writeKey = (
  cwd: string,
  key: string,
  value: Option.Option<unknown>,
): Effect.Effect<void, SettingsError> =>
  Effect.gen(function* () {
    const path = join(cwd, ".efferent", "config.json")
    const current = yield* readConfig(path)
    const next = Option.match(value, {
      onNone: () => Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
      onSome: (v) => ({ ...current, [key]: v }),
    })
    yield* writeConfigAtomic(path, next)
  })

export const LocalSettingsStoreLive = (cwd: string, home: string) =>
  Layer.succeed(SettingsStore, {
    load: Effect.gen(function* () {
      const configs = yield* Effect.forEach(configPaths(cwd, home), readConfig)
      const merged = configs.reduce((acc, c) => ({ ...acc, ...c }), {})
      return new EngineSettings({
        model: asString(merged["model"]),
        codeModel: asString(merged["codeModel"]),
        fastModel: asString(merged["fastModel"]),
        fallbackModel: asString(merged["fallbackModel"]),
        sandbox: asBoolean(merged["sandbox"]),
        viMode: asBoolean(merged["viMode"]),
        maxAttempts: asNumber(merged["maxAttempts"]),
        budgetMillis: asNumber(merged["budgetMillis"]),
      })
    }),
    setRole: (role: ModelRole, selection: Option.Option<string>) =>
      writeKey(cwd, ROLE_KEYS[role], selection),
    set: (key: SettingsKey, value: Option.Option<string>) =>
      Option.match(value, {
        onNone: () => writeKey(cwd, key, Option.none()),
        onSome: (raw) =>
          coerceSettingValue(key, raw).pipe(
            Effect.flatMap((coerced) => writeKey(cwd, key, Option.some(coerced))),
          ),
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
