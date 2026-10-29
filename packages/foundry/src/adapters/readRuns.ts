import { Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { FactoryRun } from "../domain/FactoryRun.js"

const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(FactoryRun))

/**
 * Read the persisted run history back from a `makeFileRunSink` directory —
 * the memory read (`deriveLessons` is the fold over it). DEFENSIVE by
 * design: a missing directory is an empty history, an unreadable or
 * undecodable artifact is skipped (one corrupt file must never brick the
 * next run's context). Oldest-first by `endedAt`.
 */
export const readRuns = (dir: string): Effect.Effect<ReadonlyArray<FactoryRun>> =>
  Effect.tryPromise({
    try: () => fs.readdir(dir),
    catch: () => "missing" as const,
  }).pipe(
    Effect.tapError(() => Effect.logDebug(`no run history at ${dir}`)),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => name.endsWith(".json")),
        (name) =>
          Effect.tryPromise({
            try: () => fs.readFile(path.join(dir, name), "utf-8"),
            catch: () => "unreadable" as const,
          }).pipe(
            Effect.flatMap(decodeRun),
            Effect.map((run) => [run] as ReadonlyArray<FactoryRun>),
            Effect.tapError(() => Effect.logWarning(`the run artifact ${name} is unreadable or does not decode; it is skipped`)),
            Effect.orElseSucceed(() => [] as ReadonlyArray<FactoryRun>),
          ),
      ),
    ),
    Effect.map((batches) =>
      batches.flat().sort((a, b) => a.endedAt - b.endedAt),
    ),
  )
