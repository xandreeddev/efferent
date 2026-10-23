import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import { EvaluationRunStore, EvaluationError, EvaluationRun, Trial, ComparisonSpecification } from "@xandreed/evals"

export const fileIo = <A>(action: () => Promise<A>) => Effect.tryPromise({ try: action, catch: (error) => new EvaluationError({ code: "persistence", message: String(error) }) })
export const writeJson = (path: string, value: unknown) => Effect.gen(function* () {
  yield* fileIo(() => mkdir(dirname(path), { recursive: true }))
  const temporary = `${path}.${randomUUID()}.tmp`
  yield* fileIo(() => writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }))
  yield* fileIo(() => rename(temporary, path))
})
export const readRun = (path: string) => fileIo(() => readFile(path, "utf8")).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EvaluationRun))), Effect.mapError((error) => new EvaluationError({ code: "invalid", message: String(error) })))
export const readComparisonSpecification = (path: string) => fileIo(() => readFile(path, "utf8")).pipe(
  Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(ComparisonSpecification))(text, { onExcessProperty: "error" })),
  Effect.mapError((error) => new EvaluationError({ code: "invalid", message: String(error) })),
)
/** Exclusive creation, before any subject call. A failed or interrupted attempt cannot replace its specification. */
export const writeComparisonSpecification = (directory: string, specification: typeof ComparisonSpecification.Type) =>
  Schema.encodeEffect(ComparisonSpecification)(specification).pipe(
    Effect.mapError((error) => new EvaluationError({ code: "invalid", message: String(error) })),
    Effect.flatMap((encoded) => fileIo(() => writeFile(join(directory, "comparison-spec.json"), JSON.stringify(encoded, null, 2), { flag: "wx", mode: 0o444 }))),
  )
export const EvaluationRunStoreFsLive = (directory: string) => Layer.succeed(EvaluationRunStore, {
  writeTrial: (trial) => Schema.encodeEffect(Trial)(trial).pipe(Effect.mapError((error) => new EvaluationError({ code: "persistence", message: String(error) })), Effect.flatMap((encoded) => writeJson(join(directory, "trials", `${encodeURIComponent(trial.id)}.json`), encoded))),
  writeRun: (run) => Schema.encodeEffect(EvaluationRun)(run).pipe(Effect.mapError((error) => new EvaluationError({ code: "persistence", message: String(error) })), Effect.flatMap((encoded) => writeJson(join(directory, run.phase === "executed" ? "execution.json" : "report.json"), encoded))),
})
