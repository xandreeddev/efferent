import { Effect, Schema } from "effect"
import { FileSystem } from "@xandreed/core"
import type { FsError } from "@xandreed/core"
import { ContextSet } from "./context-set.entity.js"
import { emptyContextSet } from "./context-set.entity.functions.js"

/** `<cwd>/.efferent/context.json` — the workspace's context set. */
export const contextSetPath = (cwd: string): string => `${cwd}/.efferent/context.json`

const ContextSetJson = Schema.parseJson(ContextSet)

/** The set on file; absent = empty. A file that no longer decodes is
 *  logged and read as empty — a hand-edit gone wrong must not brick every
 *  turn, and the next save rewrites it whole. */
export const loadContextSet = (cwd: string): Effect.Effect<ContextSet, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const path = contextSetPath(cwd)
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return emptyContextSet
    const text = yield* fs.read(path).pipe(Effect.orElseSucceed(() => ""))
    return yield* Schema.decodeUnknown(ContextSetJson)(text).pipe(
      Effect.catchAll((issue) =>
        Effect.logWarning(`${path}: unreadable context set — reading as empty: ${String(issue)}`).pipe(
          Effect.as(emptyContextSet),
        ),
      ),
    )
  })

export const saveContextSet = (
  cwd: string,
  set: ContextSet,
): Effect.Effect<void, FsError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    yield* fs.mkdir(`${cwd}/.efferent`).pipe(Effect.catchAll(() => Effect.void))
    const encoded = Schema.encodeSync(ContextSet)(set)
    yield* fs.write(contextSetPath(cwd), `${JSON.stringify(encoded, null, 2)}\n`)
  })
