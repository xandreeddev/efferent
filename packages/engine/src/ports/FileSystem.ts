import { Context, Schema } from "effect"
import type { Effect } from "effect"

export class FsError extends Schema.TaggedError<FsError>()("FsError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Minimal filesystem port for agent tools. Paths are absolute or
 *  caller-resolved — the port does no cwd magic. */
export class FileSystem extends Context.Tag("@xandreed/engine/FileSystem")<
  FileSystem,
  {
    readonly read: (path: string) => Effect.Effect<string, FsError>
    readonly write: (path: string, content: string) => Effect.Effect<void, FsError>
    readonly exists: (path: string) => Effect.Effect<boolean, FsError>
    readonly list: (dir: string) => Effect.Effect<ReadonlyArray<string>, FsError>
    readonly mkdir: (dir: string) => Effect.Effect<void, FsError>
    /** Delete a file. A missing path is a no-op (idempotent), not an error. */
    readonly remove: (path: string) => Effect.Effect<void, FsError>
  }
>() {}
