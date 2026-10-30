import type { Dirent, Stats } from "node:fs"
import { appendFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer, Option, Result } from "effect"
import type { Context } from "effect"
import { FileSystem, FsError, walkGlob } from "@xandreed/core"
import type { DirEntry, FileInfo, FileKind, FsReason, ReadRange, RecursiveOptions, StatOptions, WriteOptions } from "@xandreed/core"
import { errorMessageOf, fsReasonOf, pathIn, removalPlace } from "./local-system.entity.functions.js"

type Fs = Context.Service.Shape<typeof FileSystem>

const refused = (path: string, reason: FsReason, message: string) => new FsError({ path, reason, message })

/** One node:fs call on `path`; its failure is an `FsError` for that path. A relative path is refused before any IO. */
const attempt = <A>(path: string, run: () => Promise<A>): Effect.Effect<A, FsError> => path.startsWith("/")
  ? Effect.tryPromise({ try: run, catch: (error) => refused(path, fsReasonOf(error), errorMessageOf(error)) })
  : Effect.fail(refused(path, "Invalid", `paths must be absolute: ${path}`))

/** A link is reported as one only where it was not followed (`lstat`, a directory entry). */
const kindOf = (entry: Stats | Dirent): FileKind =>
  entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other"

const byName = (left: DirEntry, right: DirEntry): number => left.name < right.name ? -1 : left.name > right.name ? 1 : 0

/** A Node `Buffer` as the plain `Uint8Array` the port promises, over the same memory. */
const bytesOf = (buffer: Uint8Array): Uint8Array => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

/** Every missing directory on the way to `path`'s parent (`createParents`). */
const parentsOf = (path: string): Effect.Effect<void, FsError> => attempt(path, () => mkdir(dirname(path), { recursive: true })).pipe(Effect.asVoid)

/** The smallest read a range is made of; a file's reported size, when larger, is read in one. */
const chunkSize = 65_536

/** `chunks` as one array. */
const joined = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  chunks.reduce((at, chunk) => {
    whole.set(chunk, at)
    return at + chunk.length
  }, 0)
  return whole
}

/**
 * `readBytes` with a range: what there is of `length` bytes from `offset`,
 * read through a handle, so the rest of the file is never read. Reads go on
 * until the range is full or a read returns nothing, so a file that reports
 * a size of 0 but has content (`/proc` entries) reads like any other; its
 * reported size only sets how much each read asks for. A range from the
 * start reads sequentially, so a stream that cannot seek (a pipe) reads too.
 */
const readRange = (path: string, offset: number, length: Option.Option<number>) => Effect.acquireUseRelease(
  attempt(path, () => open(path, "r")),
  (handle: FileHandle) => attempt(path, () => handle.stat()).pipe(Effect.flatMap((info) => {
    if (info.isDirectory()) return Effect.fail(refused(path, "IsDirectory", `is a directory: ${path}`))
    const step = Math.max(chunkSize, info.size - offset)
    const gather = (position: number | null, remaining: number, chunks: ReadonlyArray<Uint8Array>): Effect.Effect<ReadonlyArray<Uint8Array>, FsError> => {
      const size = Math.min(remaining, step)
      return size <= 0 ? Effect.succeed(chunks) : attempt(path, () => handle.read(new Uint8Array(size), 0, size, position)).pipe(
        Effect.flatMap(({ bytesRead, buffer }) => bytesRead === 0 ? Effect.succeed(chunks)
          : gather(position === null ? null : position + bytesRead, remaining - bytesRead, [...chunks, buffer.subarray(0, bytesRead)])))
    }
    return gather(offset === 0 ? null : offset, Option.getOrElse(length, () => Number.POSITIVE_INFINITY), []).pipe(Effect.map(joined))
  })),
  (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.ignore({ log: "Warn", message: `the read handle of ${path} did not close` })),
)

const readBytes = (path: string, range?: ReadRange): Effect.Effect<Uint8Array, FsError> => {
  const offset = range?.offset ?? 0
  const length = Option.fromNullishOr(range?.length)
  const valid = Number.isInteger(offset) && offset >= 0 && Option.match(length, { onNone: () => true, onSome: (count) => Number.isInteger(count) && count >= 0 })
  if (!valid) return Effect.fail(refused(path, "Invalid", `offset and length must be whole numbers of at least 0, not ${JSON.stringify(range)}`))
  return offset === 0 && Option.isNone(length) ? attempt(path, () => readFile(path)).pipe(Effect.map(bytesOf)) : readRange(path, offset, length)
}

const list = (dir: string): Effect.Effect<ReadonlyArray<DirEntry>, FsError> => attempt(dir, () => readdir(dir, { withFileTypes: true })).pipe(
  Effect.map((entries) => entries.map((entry): DirEntry => ({ name: entry.name, kind: kindOf(entry) })).toSorted(byName)))

/**
 * Delete what `path` names without following it. The path is resolved
 * first, as the in-memory backend does: the root and a path ending in `.`
 * or `..` are refused (`removalPlace`), the parent's links are resolved
 * (`realpath`), and every call then works on that parent and the last name,
 * so a trailing slash or a `..` can never make it act anywhere else. A file
 * or link is unlinked, a directory removed with `rmdir` (so one with entries
 * fails with `NotEmpty`) or, only with `recursive`, with everything below it.
 * A path that is missing, or goes missing meanwhile, is already removed.
 */
const remove = (path: string, options?: RecursiveOptions): Effect.Effect<void, FsError> => Result.match(removalPlace(path), {
  onFailure: (message) => Effect.fail(refused(path, "Invalid", message)),
  onSuccess: ({ parent, name }) => attempt(path, () => realpath(parent)).pipe(
    Effect.map((dir) => pathIn(dir, name)),
    Effect.flatMap((target) => attempt(path, () => lstat(target)).pipe(Effect.flatMap((info) => !info.isDirectory() ? attempt(path, () => unlink(target))
      : options?.recursive === true ? attempt(path, () => rm(target, { recursive: true, force: true }))
      // POSIX lets rmdir report a directory with entries as EEXIST too.
      : attempt(path, () => rmdir(target)).pipe(Effect.mapError((error) => error.reason === "Exists" ? refused(path, "NotEmpty", error.message) : error))))),
    Effect.catchIf((error) => error.reason === "NotFound", () => Effect.void),
  ),
})

/** The failures of `rename` that only the destination can cause; `Exists` is how POSIX may report a directory there with entries. */
const destinationOnly: ReadonlySet<FsReason> = new Set<FsReason>(["IsDirectory", "NotEmpty", "Exists"])
/** The failures either side can cause: the source is to blame only when it is not there to move. */
const eitherSide: ReadonlySet<FsReason> = new Set<FsReason>(["NotFound", "NotDirectory", "Invalid"])

/**
 * Move `from` to `to`. A failure names the side that caused it, as the
 * in-memory backend does: one only the destination can cause names `to`
 * (a directory with entries there is `NotEmpty`); a missing or unusable
 * path names `from` when `from` itself is not there (`lstat`), `to`
 * otherwise; any other names `from`.
 */
const move = (from: string, to: string): Effect.Effect<void, FsError> => !to.startsWith("/")
  ? Effect.fail(refused(to, "Invalid", `paths must be absolute: ${to}`))
  : attempt(from, () => rename(from, to)).pipe(Effect.catch((error) => {
    const atTo = new FsError({ path: to, reason: error.reason === "Exists" ? "NotEmpty" : error.reason, message: error.message })
    return destinationOnly.has(error.reason) ? Effect.fail(atTo)
      : eitherSide.has(error.reason) ? Effect.tryPromise(() => lstat(from)).pipe(Effect.match({ onFailure: () => error, onSuccess: () => atTo }), Effect.flatMap(Effect.fail))
      : Effect.fail(error)
  }))

const statOf = (path: string, options?: StatOptions): Effect.Effect<FileInfo, FsError> =>
  attempt(path, () => options?.followSymlinks === false ? lstat(path) : stat(path)).pipe(Effect.map((info): FileInfo => ({
    path, kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs, mode: Option.some(info.mode & 0o7777),
  })))

/**
 * The machine's own file system through `node:fs/promises`, for Node and
 * Bun. Paths must be absolute (a relative one fails with `Invalid`); every
 * failure's `reason` comes from the error code (`fsReasonOf`). `glob` is
 * `walkGlob` over `list`, so it matches what every other backend matches
 * and never enters a linked directory. `remove` resolves the parent first
 * and acts on the last name only, so it never follows that name and never
 * removes the root (nor a path ending in `.` or `..`); `rename` names the
 * side a failure came from. `stat` reports the permission bits as `mode`.
 * POSIX only (Linux and macOS): a path must start with `/`. Passes
 * `fileSystemConformance` on Bun and Node.
 */
export const localFileSystem: Fs = FileSystem.of({
  read: (path) => attempt(path, () => readFile(path, "utf8")),
  readBytes,
  write: (path, content, options?: WriteOptions) =>
    (options?.createParents === true ? parentsOf(path) : Effect.void).pipe(Effect.andThen(attempt(path, () => writeFile(path, content)))),
  append: (path, content, options?: WriteOptions) =>
    (options?.createParents === true ? parentsOf(path) : Effect.void).pipe(Effect.andThen(attempt(path, () => appendFile(path, content)))),
  rename: move,
  stat: statOf,
  exists: (path) => attempt(path, () => stat(path)).pipe(
    Effect.as(true),
    Effect.catchIf((error) => error.reason === "NotFound" || error.reason === "NotDirectory", () => Effect.succeed(false)),
  ),
  list,
  glob: (pattern, options) => walkGlob(list, pattern, options),
  mkdir: (dir, options?: RecursiveOptions) => attempt(dir, () => mkdir(dir, { recursive: options?.recursive === true })).pipe(Effect.asVoid),
  realPath: (path) => attempt(path, () => realpath(path)),
  remove,
})

/**
 * The local `FileSystem` (`localFileSystem`) as a layer.
 *
 * @public
 */
export const FileSystemLive: Layer.Layer<FileSystem> = Layer.succeed(FileSystem, localFileSystem)
