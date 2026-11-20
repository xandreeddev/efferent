import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"
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
 * for a part that keeps files of its own (a pass's journal); a fresh folder made only when none is there (`fresh`, a
 * run's own). A log is written whole or not at all: to a temporary file beside it, then renamed over it, so a reader
 * never finds half a record. A name that is absolute or leads out of the folder is refused.
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
  fresh: Effect.fn("review_logs.fresh")(function* (name: string) {
    const path = yield* inside(root, name)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await mkdir(path)
      },
      catch: (cause) => new LogsUnavailable({ name, message: `the folder ${name} could not be made, or is there already`, cause }),
    })
    return path
  }),
  keep: Effect.fn("review_logs.keep")(function* (name: string, text: string) {
    const path = yield* inside(root, name)
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temporary, text, { flag: "wx" })
        await rename(temporary, path)
      },
      catch: (cause) => new LogsUnavailable({ name, message: `the log ${name} could not be written`, cause }),
    }).pipe(Effect.tapError(() => Effect.tryPromise(() => rm(temporary, { force: true })).pipe(Effect.ignore({ log: "Debug", message: "a temporary log was not there to remove" }))))
    return path
  }),
}))
