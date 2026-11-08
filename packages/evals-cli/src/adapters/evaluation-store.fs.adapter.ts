import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises"
import { Buffer } from "node:buffer"
import { StringDecoder } from "node:string_decoder"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { Cause, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { decodeJsonChunks, encodeJsonChunks, JSON_CHUNK_CHARACTERS } from "./bounded-json.adapter.js"
import { EvaluationRunStore, EvaluationError, EvaluationRun, TranscriptEvent, Trial, errorCodeOf, reasonOf } from "@xandreed/evals"

/** A failed file operation as `persistence`: `what` failed, then Node's reason (`EACCES: permission denied, mkdir '…'`); the error is the cause. */
const persistence = (what: string, error: unknown) =>
  new EvaluationError({ code: "persistence", message: `${what}: ${reasonOf(Cause.die(error))}`, cause: error })
/** @public */
export const fileIo = <A>(action: () => Promise<A>) => Effect.tryPromise({ try: action, catch: (error) => persistence("File operation failed", error) })
/** A failed read of `path`: `missing` when there is no such file, else `persistence`. */
const readFailure = (path: string) => (error: unknown) => Option.contains(errorCodeOf(error), "ENOENT")
  ? new EvaluationError({ code: "missing", message: `No file at ${path}` })
  : persistence(`Cannot read ${path}`, error)
const readIo = <A>(path: string, action: () => Promise<A>) => Effect.tryPromise({ try: action, catch: readFailure(path) })

/** Write all of `bytes` at the handle's position. */
const writeAll = (handle: FileHandle, bytes: Uint8Array): Effect.Effect<void, EvaluationError> =>
  bytes.byteLength === 0
    ? Effect.void
    : fileIo(() => handle.write(bytes)).pipe(Effect.flatMap(({ bytesWritten }) => writeAll(handle, bytes.subarray(bytesWritten))))
type Append = (text: string) => Effect.Effect<void, EvaluationError>
/**
 * Write `path` through a temporary file (mode `0600`) renamed into place,
 * `write` appending its text in parts. A failed write removes the temporary
 * file, and the write is not interrupted midway.
 */
const writeAtomically = Effect.fnUntraced(function* (path: string, write: (append: Append) => Effect.Effect<void, EvaluationError>) {
  yield* fileIo(() => mkdir(dirname(path), { recursive: true }))
  const temporary = `${path}.${randomUUID()}.tmp`
  yield* Effect.acquireUseRelease(
    fileIo(() => open(temporary, "w", 0o600)),
    (handle) => write((text) => Effect.try({ try: () => Buffer.from(text, "utf8"), catch: (error) => persistence("File operation failed", error) }).pipe(
      Effect.flatMap((bytes) => writeAll(handle, bytes)),
    )),
    (handle) => fileIo(() => handle.close()),
  ).pipe(
    Effect.andThen(fileIo(() => rename(temporary, path))),
    Effect.onError(() => fileIo(() => rm(temporary, { force: true })).pipe(Effect.ignore({ log: true }))),
    Effect.uninterruptible,
  )
})
/**
 * Write to a temporary file, then rename it into place; a failed write removes the temporary file.
 *
 * @public
 */
export const writeJson = Effect.fnUntraced(function* (path: string, value: unknown) {
  yield* writeAtomically(path, (append) => encodeJsonChunks(value, append, (error) => persistence("File operation failed", error)))
})
/**
 * A file's text: `missing` when there is no such file, `persistence` when it cannot be read.
 *
 * @public
 */
export const readText = (path: string) => readIo(path, () => readFile(path, "utf8"))
/** Read bounded UTF-8 chunks, preserving readFile's replacement and BOM behavior. */
export const readJsonInChunks = Effect.fnUntraced(function* <A, I>(path: string, schema: Schema.Codec<A, I>, chunk = JSON_CHUNK_CHARACTERS) {
  const invalid = (error: unknown) => new EvaluationError({ code: "invalid", message: `${path}: ${reasonOf(Cause.die(error))}`, cause: error })
  return yield* Effect.acquireUseRelease(
    readIo(path, () => open(path, "r")),
    Effect.fnUntraced(function* (handle) {
      const bytes = Buffer.allocUnsafe(Math.max(1, chunk))
      const decoder = new StringDecoder("utf8")
      const source = { ended: false }
      const parsed = yield* decodeJsonChunks(() => source.ended ? Effect.succeed(Option.none<string>()) : readIo(path, () => handle.read(bytes)).pipe(
        Effect.map(({ bytesRead }) => {
          if (bytesRead > 0) return Option.some(decoder.write(bytes.subarray(0, bytesRead)))
          source.ended = true
          const tail = decoder.end()
          return tail.length === 0 ? Option.none<string>() : Option.some(tail)
        }),
      ), invalid)
      return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(Effect.mapError(invalid))
    }),
    (handle) => fileIo(() => handle.close()),
  )
})
/**
 * A JSON file decoded with `schema`: `missing`, `persistence`, or `invalid` when its content does not decode.
 * The JSON text is never held whole; decoded scalars and the object graph remain in memory.
 *
 * @public
 */
export const readJson = <A, I>(path: string, schema: Schema.Codec<A, I>) => readJsonInChunks(path, schema)
/** Write the native pretty JSON bytes with a bounded text buffer, including within a trial. */
export const writeRunFile = (path: string, run: typeof EvaluationRun.Encoded, piece: number) => writeAtomically(path, (append) => encodeJsonChunks(run, append, (error) => persistence("File operation failed", error), true, piece))
/** A run read with a chosen IO chunk size; small chunks exercise all token boundaries. */
export const readRunWithin = (path: string, chunk: number) => readJsonInChunks(path, EvaluationRun, chunk)
/**
 * A run file (`execution.json`, `report.json`), without a whole-run or whole-trial text allocation.
 *
 * @public
 */
export const readRun = (path: string) => readJson(path, EvaluationRun)
/** The runner serializes each trial's records. One logical append completes before
 * ordinary interruption; a failed append restores its previous prefix. SIGKILL
 * can still leave a partial line as crash evidence, without invented completion. */
const appendJsonLine = Effect.fnUntraced(function* (path: string, value: unknown) {
  yield* fileIo(() => mkdir(dirname(path), { recursive: true }))
  yield* Effect.acquireUseRelease(
    fileIo(() => open(path, "a", 0o600)),
    Effect.fnUntraced(function* (handle) {
      const { size } = yield* fileIo(() => handle.stat())
      yield* encodeJsonChunks(value, (text) => writeAll(handle, Buffer.from(text, "utf8")), (error) => persistence("File operation failed", error), false).pipe(
        Effect.andThen(writeAll(handle, Buffer.from("\n"))),
        Effect.catchCause((cause) => fileIo(() => handle.truncate(size)).pipe(
          Effect.catchCause((rollback) => Effect.failCause(Cause.combine(cause, rollback))),
          Effect.andThen(Effect.failCause(cause)),
        )),
      )
    }),
    (handle) => fileIo(() => handle.close()),
  ).pipe(Effect.uninterruptible)
})
/** Direct store callers may overlap too. Share locks across store instances in
 * this process, and retain an entry only while it has active users/waiters.
 * Separate processes must use separate result directories. */
const appendLocks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()
const serializedAppend = (path: string, value: unknown) => Effect.acquireUseRelease(
  Effect.sync(() => {
    const key = resolve(path)
    const entry = appendLocks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
    entry.users += 1
    appendLocks.set(key, entry)
    return { key, entry }
  }),
  ({ entry }) => entry.semaphore.withPermit(appendJsonLine(path, value)),
  ({ key, entry }) => Effect.sync(() => {
    entry.users -= 1
    if (entry.users === 0) appendLocks.delete(key)
  }),
)
/**
 * The run store over `directory`: `execution.json` or `report.json`, and
 * `trials/<id>.json` per trial. A running trial's transcript events are
 * appended to `trials/<id>.events.jsonl`, one JSON line each; the file goes
 * once the settled trial (which holds them all) is written, so it remains
 * only while a trial runs or after the process died mid-trial. Runs, individual trials and event lines use bounded JSON text buffers;
 * decoded scalar strings and the full object graph still occupy memory.
 *
 * @public
 */
export const EvaluationRunStoreFsLive = (directory: string) => {
  const trialFile = (id: string, suffix: string) => join(directory, "trials", `${encodeURIComponent(id)}${suffix}`)
  return Layer.succeed(EvaluationRunStore, {
    writeTrial: (trial) => Schema.encodeEffect(Trial)(trial).pipe(
      Effect.mapError((error) => new EvaluationError({ code: "persistence", message: `Trial ${trial.id} does not encode: ${error.message}`, cause: error })),
      Effect.flatMap((encoded) => writeJson(trialFile(trial.id, ".json"), encoded)),
      Effect.andThen(trial.status === "running" ? Effect.void : fileIo(() => rm(trialFile(trial.id, ".events.jsonl"), { force: true })).pipe(
        Effect.ignore({ log: "Warn", message: `Cannot remove the event file of trial ${trial.id}` }),
      )),
    ),
    appendTranscript: (trial, event) => Schema.encodeEffect(TranscriptEvent)(event).pipe(
      Effect.mapError((error) => new EvaluationError({ code: "persistence", message: `Event ${event.id} does not encode: ${error.message}`, cause: error })),
      Effect.flatMap((encoded) => serializedAppend(trialFile(trial, ".events.jsonl"), encoded)),
    ),
    writeRun: (run) => Schema.encodeEffect(EvaluationRun)(run).pipe(Effect.mapError((error) => new EvaluationError({ code: "persistence", message: `Run ${run.id} does not encode: ${error.message}`, cause: error })), Effect.flatMap((encoded) => writeRunFile(join(directory, run.phase === "executed" ? "execution.json" : "report.json"), encoded, JSON_CHUNK_CHARACTERS))),
  })
}
