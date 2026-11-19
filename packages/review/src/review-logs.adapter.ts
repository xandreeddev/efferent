import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { Effect, Layer } from "effect"
import { LogsUnavailable } from "./review-logs.entity.js"
import { ReviewLogs } from "./review-logs.port.js"

/**
 * Logs in a folder of the disk: each under its name in `root`, which must be absolute. A name that is absolute or
 * leads out of the folder is refused.
 */
export const directoryLogs = (root: string): Layer.Layer<ReviewLogs> => Layer.succeed(ReviewLogs, ReviewLogs.of({
  keep: Effect.fn("review_logs.keep")(function* (name: string, text: string) {
    const relative = normalize(name)
    if (!isAbsolute(root) || isAbsolute(relative) || relative.startsWith("..")) return yield* Effect.fail(new LogsUnavailable({ name, message: `${name} is not a name inside the log folder` }))
    const path = join(root, relative)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
      },
      catch: (cause) => new LogsUnavailable({ name, message: `the log ${name} could not be written`, cause }),
    })
    return path
  }),
}))
