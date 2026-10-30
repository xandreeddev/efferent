import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { SettingsError, SettingsStore } from "../ports/settings-store.port.js"
import type { ModelRole, SettingsKey } from "../ports/settings-store.port.js"
import { readJsonObject, withFileLock, writeJsonObject } from "../storage/json-file.js"
import { coerceSettingValue, ROLE_FIELDS, roleSelection, settingsFromRecord } from "./settings-value.entity.functions.js"

/**
 * Settings from the SAME `config.json` files the previous line writes —
 * global `~/.efferent/config.json` merged with local `<cwd>/.efferent/
 * config.json`, local-over-global per key. `load` re-reads both files on
 * every call. Writes go to the local file, every other key in it preserved;
 * a value is checked before it is written (`setRole` takes a
 * `"<provider>:<modelId>"` selection, `set` each key's string form).
 *
 * A file that cannot be read or is not a JSON object fails `load` and every
 * write with a `SettingsError` of code `settings.corrupt`; only a missing
 * file reads as empty. A write re-reads the local file under its lock, which
 * every store in the process shares, and replaces it through a temp file of
 * its own.
 */

const configPaths = (cwd: string, home: string): ReadonlyArray<string> => [
  join(home, ".efferent", "config.json"),
  join(cwd, ".efferent", "config.json"),
]

const readConfig = (path: string): Effect.Effect<Record<string, unknown>, SettingsError> =>
  readJsonObject(path, (reason) => new SettingsError({
    code: "settings.corrupt",
    message: `${path} ${reason}: fix or remove it; nothing was read from it or written to it`,
  })).pipe(Effect.map(Option.getOrElse(() => ({}))))

/** Write (or drop) one key in the LOCAL config, every other key preserved. */
const writeKey = (
  cwd: string,
  key: string,
  value: Option.Option<unknown>,
): Effect.Effect<void, SettingsError> => {
  const path = join(cwd, ".efferent", "config.json")
  return withFileLock(path)(Effect.gen(function* () {
    const current = yield* readConfig(path)
    const next = Option.match(value, {
      onNone: () => Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
      onSome: (v) => ({ ...current, [key]: v }),
    })
    yield* writeJsonObject(path, next, Option.none(), (reason) => new SettingsError({ message: `config.json write failed: ${reason}` }))
  }))
}

/** @public */
export const LocalSettingsStoreLive = (cwd: string, home: string) =>
  Layer.succeed(SettingsStore, {
    load: Effect.forEach(configPaths(cwd, home), readConfig, { concurrency: 1 }).pipe(
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
