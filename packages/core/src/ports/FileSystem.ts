import { Context, Data, type Effect } from "effect"

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly cause: unknown
  readonly message: string
}> {}

export class FileNotFound extends Data.TaggedError("FileNotFound")<{
  readonly path: string
}> {}

export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
  readonly path: string
}> {}

export class NotADirectory extends Data.TaggedError("NotADirectory")<{
  readonly path: string
}> {}

export interface FileReadResult {
  readonly content: string
  readonly truncated: boolean
  readonly totalLines: number
}

export interface DirEntry {
  readonly path: string
  readonly type: "file" | "dir"
}

export class FileSystem extends Context.Tag("@efferent/core/FileSystem")<
  FileSystem,
  {
    readonly read: (
      path: string,
      opts?: { offset?: number; limit?: number },
    ) => Effect.Effect<
      FileReadResult,
      FileNotFound | PermissionDenied | FileSystemError
    >
    readonly write: (
      path: string,
      content: string,
    ) => Effect.Effect<void, PermissionDenied | FileSystemError>
    readonly exists: (path: string) => Effect.Effect<boolean, FileSystemError>
    readonly list: (
      path: string,
      opts?: { recursive?: boolean },
    ) => Effect.Effect<
      ReadonlyArray<DirEntry>,
      FileNotFound | NotADirectory | FileSystemError
    >
    readonly glob: (
      pattern: string,
      opts?: { cwd?: string; respectGitignore?: boolean },
    ) => Effect.Effect<ReadonlyArray<string>, FileSystemError>
  }
>() {}
