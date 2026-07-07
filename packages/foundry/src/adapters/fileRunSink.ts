import { Effect, Layer, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { WorkspaceError } from "../domain/Errors.js"
import { FactoryRun } from "../domain/FactoryRun.js"
import { RunSink } from "../ports/RunSink.js"

/** Persists each run as Schema-encoded JSON under `dir` — the artifact is
 *  self-describing (decode it back with the same schema). */
export const makeFileRunSink = (dir: string): Layer.Layer<RunSink> =>
  Layer.succeed(RunSink, {
    persist: (run) =>
      Schema.encode(FactoryRun)(run).pipe(
        Effect.mapError(
          (parseError) => new WorkspaceError({ message: `artifact encode failed: ${parseError.message}` }),
        ),
        Effect.flatMap((encoded) =>
          Effect.tryPromise({
            try: async () => {
              await fs.mkdir(dir, { recursive: true })
              const file = path.join(dir, `${run.id}.json`)
              await fs.writeFile(file, `${JSON.stringify(encoded, null, 2)}\n`)
              return file
            },
            catch: (cause) =>
              new WorkspaceError({ message: `artifact write failed: ${String(cause)}` }),
          }),
        ),
      ),
  })
