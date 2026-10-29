import { Context } from "effect"
import type { Effect } from "effect"
import type { DirEntry, FileInfo, FsError, GlobOptions, GlobResult, ReadRange, RecursiveOptions, StatOptions, WriteOptions } from "../domain/file-system.entity.js"

/**
 * The file system agent tools work through. Paths are absolute (the port
 * does no cwd magic) and POSIX; every failure is an `FsError` whose
 * `reason` is the same on every backend. Calls follow symbolic links,
 * except `list` (which reports links as `symlink`), `remove` (which removes
 * the link), `rename` (which moves the link, not its target) and `stat`
 * with `followSymlinks: false`. `fileSystemConformance`
 * is the contract as runnable checks; `FileSystemMemoryLive` is the
 * in-memory backend.
 */
export class FileSystem extends Context.Service<FileSystem, {
    /** A file's text, decoded as UTF-8. */
    readonly read: (path: string) => Effect.Effect<string, FsError>
    /** A file's bytes, or a range of them; a range past the end returns what there is. */
    readonly readBytes: (path: string, range?: ReadRange) => Effect.Effect<Uint8Array, FsError>
    /** Create or replace a file (text is written as UTF-8). Without `createParents`, a missing parent fails with `NotFound`. */
    readonly write: (path: string, content: string | Uint8Array, options?: WriteOptions) => Effect.Effect<void, FsError>
    /** Add to the end of a file, creating it when missing. */
    readonly append: (path: string, content: string | Uint8Array, options?: WriteOptions) => Effect.Effect<void, FsError>
    /** Move a file, directory or link (the link itself, not its target); an existing file at `to` is replaced. */
    readonly rename: (from: string, to: string) => Effect.Effect<void, FsError>
    readonly stat: (path: string, options?: StatOptions) => Effect.Effect<FileInfo, FsError>
    /** Whether the path exists (a link whose target is missing does not). A missing path is `false`, not an error. */
    readonly exists: (path: string) => Effect.Effect<boolean, FsError>
    /** A directory's entries, sorted by name (code-unit order), links not followed. */
    readonly list: (dir: string) => Effect.Effect<ReadonlyArray<DirEntry>, FsError>
    /** The paths under `options.cwd` the pattern matches (`*`, `**`, `?`, `[...]`, `{a,b}`); links are never entered. */
    readonly glob: (pattern: string, options: GlobOptions) => Effect.Effect<GlobResult, FsError>
    /** Create a directory. Without `recursive`, an existing path fails with `Exists` and a missing parent with `NotFound`; with it, existing directories are fine. */
    readonly mkdir: (dir: string, options?: RecursiveOptions) => Effect.Effect<void, FsError>
    /** The canonical absolute path, every symbolic link resolved. */
    readonly realPath: (path: string) => Effect.Effect<string, FsError>
    /**
     * Delete a file, a link (not its target) or a directory. A missing path
     * is a no-op. Without `recursive`, an empty directory is removed and one
     * with entries fails with `NotEmpty`.
     */
    readonly remove: (path: string, options?: RecursiveOptions) => Effect.Effect<void, FsError>
  }>()("@xandreed/core/FileSystem") {}
