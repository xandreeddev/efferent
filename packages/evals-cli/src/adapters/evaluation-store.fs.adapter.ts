import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { Cause, Effect, Layer, Predicate, Schema } from "effect"
import { EvaluationRunStore, EvaluationError, EvaluationRun, Trial, reasonOf } from "@xandreed/evals"

/** A failed file operation as `persistence`: `what` failed, then Node's reason (`EACCES: permission denied, mkdir '…'`); the error is the cause. */
const persistence = (what: string, error: unknown) =>
  new EvaluationError({ code: "persistence", message: `${what}: ${reasonOf(Cause.die(error))}`, cause: error })
/** @public */
export const fileIo = <A>(action: () => Promise<A>) => Effect.tryPromise({ try: action, catch: (error) => persistence("File operation failed", error) })
/**
 * Write to a temporary file, then rename it into place; a failed write removes the temporary file.
 *
 * @public
 */
export const writeJson = Effect.fnUntraced(function* (path: string, value: unknown) {
  yield* fileIo(() => mkdir(dirname(path), { recursive: true }))
  const temporary = `${path}.${randomUUID()}.tmp`
  yield* fileIo(() => writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })).pipe(
    Effect.andThen(fileIo(() => rename(temporary, path))),
    Effect.onError(() => fileIo(() => rm(temporary, { force: true })).pipe(Effect.ignore({ log: true }))),
    Effect.uninterruptible,
  )
})
/**
 * A file's text: `missing` when there is no such file, `persistence` when it cannot be read.
 *
 * @public
 */
export const readText = (path: string) => Effect.tryPromise({
  try: () => readFile(path, "utf8"),
  catch: (error) => Predicate.hasProperty(error, "code") && error.code === "ENOENT"
    ? new EvaluationError({ code: "missing", message: `No file at ${path}` })
    : persistence(`Cannot read ${path}`, error),
})
/**
 * A JSON file decoded with `schema`: `missing`, `persistence`, or `invalid` when its content does not decode.
 *
 * @public
 */
export const readJson = <A, I>(path: string, schema: Schema.Codec<A, I>) => readText(path).pipe(
  Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `${path}: ${error.message}` })),
  )),
)
/** @public */
export const readRun = (path: string) => readJson(path, EvaluationRun)
/** @public */
export const EvaluationRunStoreFsLive = (directory: string) => Layer.succeed(EvaluationRunStore, {
  writeTrial: (trial) => Schema.encodeEffect(Trial)(trial).pipe(Effect.mapError((error) => new EvaluationError({ code: "persistence", message: `Trial ${trial.id} does not encode: ${error.message}`, cause: error })), Effect.flatMap((encoded) => writeJson(join(directory, "trials", `${encodeURIComponent(trial.id)}.json`), encoded))),
  writeRun: (run) => Schema.encodeEffect(EvaluationRun)(run).pipe(Effect.mapError((error) => new EvaluationError({ code: "persistence", message: `Run ${run.id} does not encode: ${error.message}`, cause: error })), Effect.flatMap((encoded) => writeJson(join(directory, run.phase === "executed" ? "execution.json" : "report.json"), encoded))),
})
