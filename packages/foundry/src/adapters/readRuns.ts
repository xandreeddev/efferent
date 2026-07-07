import { Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { FactoryRun } from "../domain/FactoryRun.js"

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
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => name.endsWith(".json")),
        (name) =>
          Effect.tryPromise({
            try: () => fs.readFile(path.join(dir, name), "utf-8"),
            catch: () => "unreadable" as const,
          }).pipe(
            Effect.flatMap((text) =>
              Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => "not-json" as const }),
            ),
            Effect.flatMap(Schema.decodeUnknown(FactoryRun)),
            Effect.map((run) => [run] as ReadonlyArray<FactoryRun>),
            Effect.orElseSucceed(() => [] as ReadonlyArray<FactoryRun>),
          ),
      ),
    ),
    Effect.map((batches) =>
      batches.flat().sort((a, b) => a.endedAt - b.endedAt),
    ),
  )
