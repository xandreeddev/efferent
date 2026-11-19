import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize } from "node:path"
import { Effect, Layer } from "effect"
import { LogsUnavailable } from "./review-logs.entity.js"
import { ReviewLogs } from "./review-logs.port.js"

/** A name's path inside `root`, or the refusal of a name that is absolute or leads out of it. */
const inside = (root: string, name: string) => {
  const relative = normalize(name)
  return !isAbsolute(root) || isAbsolute(relative) || relative.startsWith("..")
    ? Effect.fail(new LogsUnavailable({ name, message: `${name} is not a name inside the log folder` }))
    : Effect.succeed(join(root, relative))
}

/**
 * Logs in a folder of the disk: each under its name in `root`, which must be absolute; a folder made under its name
 * for a part that keeps files of its own (a pass's journal). A name that is absolute or leads out of the folder is
 * refused.
 */
export const directoryLogs = (root: string): Layer.Layer<ReviewLogs> => Layer.succeed(ReviewLogs, ReviewLogs.of({
  folder: Effect.fn("review_logs.folder")(function* (name: string) {
    const path = yield* inside(root, name)
    yield* Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: (cause) => new LogsUnavailable({ name, message: `the folder ${name} could not be made`, cause }),
    })
    return path
  }),
  keep: Effect.fn("review_logs.keep")(function* (name: string, text: string) {
    const path = yield* inside(root, name)
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
