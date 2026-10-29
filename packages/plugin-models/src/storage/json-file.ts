import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Effect, Option, Predicate, Random, Schema, Semaphore } from "effect"

/**
 * The JSON object files the local stores keep (`auth.json`, `config.json`):
 * read so that a file that cannot be used is never taken for an empty one,
 * written atomically, and written under a lock per file that every store in
 * the process shares. The lock does not reach other processes: two
 * processes writing one file can still lose an update.
 */

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const isMissing = (cause: unknown): boolean => Predicate.hasProperty(cause, "code") && cause.code === "ENOENT"
const codeOf = (cause: unknown): string => Predicate.hasProperty(cause, "code") ? String(cause.code) : String(cause)

/**
 * Read the JSON object in `path`: `None` when no file is there. A file that
 * cannot be read (any error but ENOENT: permissions, a directory) or does
 * not hold a JSON object fails with `unusable(reason)`.
 */
export const readJsonObject = <E>(path: string, unusable: (reason: string) => E): Effect.Effect<Option.Option<Record<string, unknown>>, E> =>
  Effect.tryPromise({ try: () => readFile(path, "utf-8"), catch: (cause) => cause }).pipe(
    Effect.map(Option.some),
    Effect.catchIf(isMissing, () => Effect.succeed(Option.none<string>())),
    Effect.mapError((cause) => unusable(`could not be read (${codeOf(cause)})`)),
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(Option.none<Record<string, unknown>>()),
      onSome: (text) => Schema.decodeUnknownEffect(JsonObject)(text).pipe(
        Effect.map(Option.some),
        Effect.mapError(() => unusable("does not hold a JSON object")),
      ),
    })),
  )

/**
 * Replace `path` with `value`: written to a temp file of its own beside it
 * (named by the process and a random number, so concurrent writes never
 * share one), given `mode` when there is one, then renamed over. A failed
 * write removes its temp file.
 */
export const writeJsonObject = <E>(
  path: string,
  value: Record<string, unknown>,
  mode: Option.Option<number>,
  failed: (reason: string) => E,
): Effect.Effect<void, E> =>
  Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER).pipe(Effect.flatMap((suffix) => {
    const tmp = `${path}.tmp-${process.pid}-${suffix.toString(36)}`
    return Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(tmp, JSON.stringify(value, null, 2), "utf-8")
        await Option.match(mode, { onNone: () => Promise.resolve(), onSome: (bits) => chmod(tmp, bits) })
        await rename(tmp, path)
      },
      catch: (cause) => failed(String(cause)),
    }).pipe(Effect.tapError(() => Effect.promise(() => rm(tmp, { force: true }).then(() => undefined, () => undefined))))
  }))

/** One lock per key (a file's resolved path), for every store in the process. */
const locks = new Map<string, Semaphore.Semaphore>()

const lockOf = (key: string): Effect.Effect<Semaphore.Semaphore> => Effect.sync(() => Option.getOrElse(Option.fromNullishOr(locks.get(key)), () => {
  const made = Semaphore.makeUnsafe(1)
  locks.set(key, made)
  return made
}))

/** A lock of its own for `name` at `path` (one refresh of a provider's token kept there, say). */
export const namedLock = (path: string, name: string): Effect.Effect<Semaphore.Semaphore> => lockOf(`${name}:${resolve(path)}`)

/** Run `effect` holding the lock of `path`, which every store in the process that writes the file shares. */
export const withFileLock = (path: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(namedLock(path, "file"), (lock) => lock.withPermit(effect))
