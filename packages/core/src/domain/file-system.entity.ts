import { Schema } from "effect"

/**
 * Why a file-system call failed, the same on every backend:
 * - `NotFound`: the path, or a directory on the way to it, does not exist;
 * - `Exists`: something is already there (a non-recursive `mkdir`);
 * - `IsDirectory`: a file operation met a directory;
 * - `NotDirectory`: a directory operation met a file, or a path runs through one;
 * - `NotEmpty`: a non-recursive `remove` of a directory with entries;
 * - `Permission`: the backend refused access;
 * - `Invalid`: the call itself is malformed (a relative path, a bad range or pattern, a symlink loop);
 * - `Io`: anything else the backend reports.
 */
export const FsReason = Schema.Literals(["NotFound", "Exists", "IsDirectory", "NotDirectory", "NotEmpty", "Permission", "Invalid", "Io"])
export type FsReason = typeof FsReason.Type

/** A failed file-system call: the path it was given, why, and the backend's message. */
export class FsError extends Schema.TaggedError<FsError>()("FsError", {
  path: Schema.String,
  reason: FsReason,
  message: Schema.String,
}) {}

/** What a path holds. `symlink` is reported only where links are not followed (`list`, `stat` with `followSymlinks: false`). */
export const FileKind = Schema.Literals(["file", "directory", "symlink", "other"])
export type FileKind = typeof FileKind.Type

/** What `stat` reports. `path` is the path asked for; `mode` holds the permission bits where the backend has them. */
export const FileInfo = Schema.Struct({
  path: Schema.String,
  kind: FileKind,
  size: Schema.Number,
  mtimeMs: Schema.Number,
  mode: Schema.OptionFromOptionalKey(Schema.Int),
})
export type FileInfo = typeof FileInfo.Type

/** One entry of a directory listing; links are not followed. */
export const DirEntry = Schema.Struct({
  name: Schema.String,
  kind: FileKind,
})
export type DirEntry = typeof DirEntry.Type

/** The bytes `readBytes` returns: from `offset` (default 0), at most `length` of them (default: to the end). */
export const ReadRange = Schema.Struct({
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  length: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type ReadRange = typeof ReadRange.Type

/** `write` and `append`: with `createParents`, missing directories on the way are created first. */
export const WriteOptions = Schema.Struct({
  createParents: Schema.optionalKey(Schema.Boolean),
})
export type WriteOptions = typeof WriteOptions.Type

/** `stat` follows symbolic links unless `followSymlinks` is false. */
export const StatOptions = Schema.Struct({
  followSymlinks: Schema.optionalKey(Schema.Boolean),
})
export type StatOptions = typeof StatOptions.Type

/** `mkdir` and `remove`: `recursive` creates missing parents, or removes a directory with what it holds. */
export const RecursiveOptions = Schema.Struct({
  recursive: Schema.optionalKey(Schema.Boolean),
})
export type RecursiveOptions = typeof RecursiveOptions.Type

/**
 * How a glob walks. `cwd` is the absolute directory the pattern is relative
 * to. `exclude` prunes entries anywhere in the walk: a pattern without a `/`
 * is matched against each entry's name (`node_modules`, `*.log`), one with a
 * `/` against its path relative to `cwd`; an excluded directory is not
 * entered. Entries whose name starts with a dot are matched and entered only
 * with `dot`, or where the pattern names them with a literal dot
 * (`.github/**`). `onlyFiles` keeps regular files (not directories, links or
 * other entries). The walk stops once it has found one more than `limit`
 * paths, and reports `truncated`.
 */
export const GlobOptions = Schema.Struct({
  cwd: Schema.String,
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  dot: Schema.optionalKey(Schema.Boolean),
  onlyFiles: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type GlobOptions = typeof GlobOptions.Type

/**
 * What `glob` found: POSIX paths relative to its `cwd`, depth-first with each
 * directory's entries by name (so a directory comes before what it holds),
 * at most `limit` of them; `truncated` when more matched.
 */
export const GlobResult = Schema.Struct({
  paths: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
})
export type GlobResult = typeof GlobResult.Type
