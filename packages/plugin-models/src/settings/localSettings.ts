import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { asJsonRecord, parseJsonWarn, SettingsError, SettingsStore } from "@xandreed/core"
import type { ModelRole, SettingsKey } from "@xandreed/core"
import { coerceSettingValue, ROLE_FIELDS, roleSelection, settingsFromRecord } from "./settings-value.entity.functions.js"

/**
 * Settings from the SAME `config.json` files the previous line writes —
 * global `~/.efferent/config.json` merged with local `<cwd>/.efferent/
 * config.json`, local-over-global per key. `load` re-reads both files on
 * every call. Writes go to the local file, every other key in it preserved;
 * a value is checked before it is written (`setRole` takes a
 * `"<provider>:<modelId>"` selection, `set` each key's string form).
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
    load: Effect.forEach(configPaths(cwd, home), readConfig).pipe(
      Effect.map((configs) => settingsFromRecord(configs.reduce((acc, c) => ({ ...acc, ...c }), {}))),
    ),
    setRole: (role: ModelRole, selection: Option.Option<string>) =>
      roleSelection(role, selection).pipe(Effect.flatMap((checked) => writeKey(cwd, ROLE_FIELDS[role], checked))),
    set: (key: SettingsKey, value: Option.Option<string>) =>
      Option.match(value, {
        onNone: () => writeKey(cwd, key, Option.none()),
        onSome: (raw) =>
          coerceSettingValue(key, raw).pipe(
            Effect.flatMap((coerced) => writeKey(cwd, key, Option.some(coerced))),
          ),
      }),
  })

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
