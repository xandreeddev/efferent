import { appendFile, mkdir, open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises"
import { Buffer, constants } from "node:buffer"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { Cause, Effect, Layer, Option, Schema } from "effect"
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

/** `JSON.stringify(value, null, 2)`; a value it refuses (or text too long for one string) fails as `persistence`. */
const stringified = (value: unknown) => Effect.try({ try: () => JSON.stringify(value, null, 2), catch: (error) => persistence("File operation failed", error) })
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
  yield* writeAtomically(path, (append) => stringified(value).pipe(Effect.flatMap(append)))
})
/**
 * A file's text: `missing` when there is no such file, `persistence` when it cannot be read.
 *
 * @public
 */
export const readText = (path: string) => readIo(path, () => readFile(path, "utf8"))
/** JSON text of `path` decoded with `schema`, `invalid` when it does not decode. */
const decodeText = <A, I>(path: string, schema: Schema.Codec<A, I>) => (text: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
  Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `${path}: ${error.message}` })),
)
/**
 * A JSON file decoded with `schema`: `missing`, `persistence`, or `invalid` when its content does not decode.
 *
 * @public
 */
export const readJson = <A, I>(path: string, schema: Schema.Codec<A, I>) => readText(path).pipe(Effect.flatMap(decodeText(path, schema)))

/*
 * A run file holds `JSON.stringify(run, null, 2)` of the encoded run, but a
 * run's trials together may outgrow the longest string the runtime builds
 * (V8's is just under 512 MiB). So the store writes that text in parts: the
 * run up to its `trials` array, each trial stringified on its own, then the
 * rest. A file that fits in one string is read back whole; a larger one is
 * cut at its trials' bounds and each part parsed on its own. In this text a
 * line break stands only between tokens (one inside a string is escaped) and
 * is followed by two spaces per depth, so the lines below can only be the
 * run's `trials` key and the bounds of its elements.
 */
/** A new line at depth one: a member of the run. */
const MEMBER_LINE = "\n  "
/** A new line at depth two: an element of `trials`. */
const ELEMENT_LINE = "\n    "
const TRIALS_KEY = `${MEMBER_LINE}"trials": [`
/** The `trials` key, then its first trial's opening. */
const FIRST = Buffer.from(`${TRIALS_KEY}${ELEMENT_LINE}{`)
/** A trial's close, then the next one's opening. */
const NEXT = Buffer.from(`${ELEMENT_LINE}},${ELEMENT_LINE}{`)
/** The last trial's close, then the array's. */
const LAST = Buffer.from(`${ELEMENT_LINE}}${MEMBER_LINE}]`)
/** What a search window keeps of its end, so that a line split between two reads is still found. */
const CARRY = FIRST.length - 1
/** How many bytes a search reads at once. */
const CHUNK_BYTES = 4 << 20
/** About how many characters of a stringified trial are indented and written at once. */
const PIECE_CHARACTERS = 1 << 24

/** The run's text up to its `trials` array's `[`, and from its `]` on: with nothing between, `JSON.stringify` of the run without trials. */
const frameOf = (run: typeof EvaluationRun.Encoded) => stringified({ ...run, trials: [] }).pipe(Effect.map((text) => {
  const at = text.indexOf(`${TRIALS_KEY}]`)
  return at < 0 ? Option.none() : Option.some({ head: text.slice(0, at + TRIALS_KEY.length), tail: text.slice(at + TRIALS_KEY.length) })
}))
/** A stringified trial from `from` on, as an element of `trials`: each line break followed by the element's indentation, about `piece` characters at a time. */
const appendIndented = (append: Append, text: string, from: number, piece: number, prefix: string): Effect.Effect<void, EvaluationError> => {
  const cut = text.indexOf("\n", from + Math.max(piece, 1))
  return append(`${prefix}${text.slice(from, cut < 0 ? text.length : cut).replaceAll("\n", ELEMENT_LINE)}`).pipe(
    Effect.andThen(cut < 0 ? Effect.void : Effect.suspend(() => appendIndented(append, text, cut, piece, ""))),
  )
}
/**
 * Write `JSON.stringify(run, null, 2)` in parts of about `piece` characters,
 * none holding more than one trial, so the file may hold more than one string
 * can; the store writes with `PIECE_CHARACTERS`.
 */
export const writeRunFile = (path: string, run: typeof EvaluationRun.Encoded, piece: number) => writeAtomically(path, (append) => frameOf(run).pipe(
  Effect.flatMap(Option.match({
    onNone: () => stringified(run).pipe(Effect.flatMap(append)),
    onSome: ({ head, tail }) => append(head).pipe(
      Effect.andThen(Effect.forEach(run.trials, (trial, index) => stringified(trial).pipe(
        Effect.flatMap((text) => appendIndented(append, text, 0, piece, `${index === 0 ? "" : ","}${ELEMENT_LINE}`)),
      ), { concurrency: 1, discard: true })),
      Effect.andThen(append(run.trials.length === 0 ? tail : `${MEMBER_LINE}${tail}`)),
    ),
  })),
))

/** An open run file, searched `chunk` bytes at a time. */
interface Source { readonly path: string; readonly handle: FileHandle; readonly chunk: number }
/** The bytes of `[start, end)`. */
const readRange = ({ path, handle }: Source, start: number, end: number) => {
  const bytes = Buffer.allocUnsafe(end - start)
  const fill = (filled: number): Effect.Effect<Buffer, EvaluationError> => filled === bytes.length
    ? Effect.succeed(bytes)
    : readIo(path, () => handle.read(bytes, filled, bytes.length - filled, start + filled)).pipe(Effect.flatMap(({ bytesRead }) => bytesRead === 0
      ? Effect.fail(new EvaluationError({ code: "persistence", message: `${path} ended at byte ${start + filled}, before the run it held` }))
      : fill(filled + bytesRead)))
  return fill(0)
}
const textOf = (source: Source, start: number, end: number) => readRange(source, start, end).pipe(
  Effect.flatMap((bytes) => Effect.try({ try: () => bytes.toString("utf8"), catch: readFailure(source.path) })),
)
/** The bytes of a file from `offset`; the search goes on from `from`, an index into `bytes`. */
interface Window { readonly bytes: Buffer; readonly offset: number; readonly from: number }
/** The window, from what may still begin a line searched for, and the file's next chunk; none at the end of the file. */
const nextWindow = ({ path, handle, chunk }: Source, window: Window) => {
  const kept = Math.max(window.from, window.bytes.length - CARRY)
  const buffer = Buffer.allocUnsafe(window.bytes.length - kept + chunk)
  window.bytes.copy(buffer, 0, kept)
  return readIo(path, () => handle.read(buffer, window.bytes.length - kept, chunk, window.offset + window.bytes.length)).pipe(
    Effect.map(({ bytesRead }) => bytesRead === 0
      ? Option.none<Window>()
      : Option.some({ bytes: buffer.subarray(0, window.bytes.length - kept + bytesRead), offset: window.offset + kept, from: 0 })),
  )
}
/** The file offset of the `trials` key, and the window from its first trial's opening; none when the file has no such line. */
const findFirst = (source: Source, window: Window): Effect.Effect<Option.Option<readonly [number, Window]>, EvaluationError> => {
  const at = window.bytes.indexOf(FIRST, window.from)
  return at >= 0
    ? Effect.succeed(Option.some([window.offset + at, { ...window, from: at + FIRST.length - 1 }] as const))
    : nextWindow(source, window).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(Option.none()),
      onSome: (next) => findFirst(source, next),
    })))
}
/**
 * Push the byte range of each trial, the one opening at `start` first, and
 * return the file offset of the array's `]`; none when the file ends first.
 */
const findTrials = (
  source: Source,
  window: Window,
  start: number,
  trials: Array<readonly [number, number]>,
): Effect.Effect<Option.Option<number>, EvaluationError> => {
  const { bytes, offset, from } = window
  const next = bytes.indexOf(NEXT, from)
  // The array's close counts only before the next bound: the gates after it have bounds of the same shape.
  const last = bytes.subarray(from, next < 0 ? bytes.length : next).indexOf(LAST)
  if (last >= 0) {
    trials.push([start, offset + from + last + ELEMENT_LINE.length + 1])
    return Effect.succeed(Option.some(offset + from + last + LAST.length - 1))
  }
  if (next >= 0) {
    trials.push([start, offset + next + ELEMENT_LINE.length + 1])
    return Effect.suspend(() => findTrials(source, { ...window, from: next + NEXT.length - 1 }, offset + next + NEXT.length - 1, trials))
  }
  return nextWindow(source, window).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.succeed(Option.none()),
    onSome: (more) => findTrials(source, more, start, trials),
  })))
}
/**
 * The run in a file of `size` bytes, read in parts: the run without its
 * trials, then each trial, none of them in one string with another; the
 * bounds are searched `chunk` bytes at a time (`CHUNK_BYTES` for the store).
 * None when the file is not laid out as `JSON.stringify(run, null, 2)` (no
 * `trials` array of objects at depth one, or a run around it that
 * `JSON.stringify` would write otherwise).
 */
export const readRunInParts = Effect.fnUntraced(function* (path: string, size: number, chunk: number) {
  return yield* Effect.acquireUseRelease(
    readIo(path, () => open(path, "r")),
    Effect.fnUntraced(function* (handle) {
      const source = { path, handle, chunk }
      const first = yield* findFirst(source, { bytes: Buffer.alloc(0), offset: 0, from: 0 })
      if (Option.isNone(first)) return Option.none<EvaluationRun>()
      const [key, window] = first.value
      const trials: Array<readonly [number, number]> = []
      const close = yield* findTrials(source, window, window.offset + window.from, trials)
      if (Option.isNone(close)) return Option.none<EvaluationRun>()
      const text = (yield* textOf(source, 0, key + TRIALS_KEY.length)) + (yield* textOf(source, close.value, size))
      const rest = yield* decodeText(path, Schema.JsonObject)(text)
      if (JSON.stringify(rest, null, 2) !== text) return Option.none<EvaluationRun>()
      const encoded = yield* Effect.forEach(trials, ([start, end]) => textOf(source, start, end).pipe(
        Effect.flatMap(decodeText(path, Schema.Json)),
      ), { concurrency: 1 })
      return Option.some(yield* Schema.decodeUnknownEffect(EvaluationRun)({ ...rest, trials: encoded }).pipe(
        Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `${path}: ${error.message}` })),
      ))
    }),
    (handle) => fileIo(() => handle.close()),
  )
})
/**
 * `readRun` where the longest string is `limit` UTF-16 code units: a file of
 * at most `limit` bytes is read whole, a larger one in parts, or whole as
 * before when it is not laid out as the store writes it.
 */
export const readRunWithin = Effect.fnUntraced(function* (path: string, limit: number) {
  const { size } = yield* readIo(path, () => stat(path))
  const parts = size > limit ? yield* readRunInParts(path, size, CHUNK_BYTES) : Option.none<EvaluationRun>()
  return Option.isSome(parts) ? parts.value : yield* readJson(path, EvaluationRun)
})
/**
 * A run file (`execution.json`, `report.json`) of any size.
 *
 * @public
 */
export const readRun = (path: string) => readRunWithin(path, constants.MAX_STRING_LENGTH)
/** Append `value` as one line of JSON; a new file gets mode `0600`. */
const appendJsonLine = Effect.fnUntraced(function* (path: string, value: unknown) {
  yield* fileIo(() => mkdir(dirname(path), { recursive: true }))
  yield* fileIo(() => appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }))
})
/**
 * The run store over `directory`: `execution.json` or `report.json`, and
 * `trials/<id>.json` per trial. A running trial's transcript events are
 * appended to `trials/<id>.events.jsonl`, one JSON line each; the file goes
 * once the settled trial (which holds them all) is written, so it remains
 * only while a trial runs or after the process died mid-trial. The run file
 * is written a trial at a time, so the trials together may outgrow a string.
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
      Effect.flatMap((encoded) => appendJsonLine(trialFile(trial, ".events.jsonl"), encoded)),
    ),
    writeRun: (run) => Schema.encodeEffect(EvaluationRun)(run).pipe(Effect.mapError((error) => new EvaluationError({ code: "persistence", message: `Run ${run.id} does not encode: ${error.message}`, cause: error })), Effect.flatMap((encoded) => writeRunFile(join(directory, run.phase === "executed" ? "execution.json" : "report.json"), encoded, PIECE_CHARACTERS))),
  })
}
