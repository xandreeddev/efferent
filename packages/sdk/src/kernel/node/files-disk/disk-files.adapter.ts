import { randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { Array as Arr, Effect, Layer, Option, Order, Schema, Semaphore } from "effect"
import { FileChanged, FileNotFound, FilePath, FilesRefused, FilesUnavailable } from "../../contracts/files/files.entity.js"
import type { Expected } from "../../contracts/files/files.entity.js"
import { Files } from "../../contracts/files/files.port.js"
import { DEFAULT_IGNORE, DEFAULT_MAX_BYTES } from "./disk-files.entity.js"
import type { DiskFilesOptions } from "./disk-files.entity.js"
import { errorCodeOf, isInside, isTempName, messageOf, tempNameOf } from "./disk-files.entity.functions.js"

const isFilePath = Schema.is(FilePath)

/** Whether a failure says nothing is at a path: no such entry, or a file where a folder of the path should be. */
const isAbsence = (cause: unknown) => Option.exists(errorCodeOf(cause), (code) => code === "ENOENT" || code === "ENOTDIR")

/** One file system call; its failure as it came. */
const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => cause })

/**
 * The lane each workspace's writes take, by its root's real path: one write at a time in the process, whichever
 * `diskFiles` layer of the process makes it, so a write's compare and its rename are not split by another of them.
 */
const lanes = new Map<string, Semaphore.Semaphore>()
const laneOf = (root: string): Semaphore.Semaphore => {
  const found = lanes.get(root)
  if (found !== undefined) return found
  const made = Semaphore.makeUnsafe(1)
  lanes.set(root, made)
  return made
}

/** Text as the workspace keeps it: UTF-8, a byte-order mark kept as the character it is, so a file is written back as it was read. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/**
 * A file system failure as the workspace's, in one place: no file there is `FileNotFound`; a call the system does not
 * allow, and a link that leads back to itself, are declined in words (`FilesRefused`), which the model reads; anything
 * else is the medium's failure (`FilesUnavailable`).
 */
const failureOf = (path: FilePath, doing: "read" | "written") => (cause: unknown): FileNotFound | FilesRefused | FilesUnavailable =>
  Option.match(errorCodeOf(cause), {
    onNone: () => new FilesUnavailable({ message: `${path} could not be ${doing}: ${messageOf(cause)}` }),
    onSome: (code) => code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR"
      ? new FileNotFound({ path, message: `no file is at ${path}` })
      : code === "EACCES" || code === "EPERM"
        ? new FilesRefused({ path, reason: `the system does not let it be ${doing}`, message: `${path} could not be ${doing}: ${messageOf(cause)}` })
        : code === "ELOOP"
          ? new FilesRefused({ path, reason: "it is a link that leads back to itself", message: `${path} could not be ${doing}: ${messageOf(cause)}` })
          : new FilesUnavailable({ message: `${path} could not be ${doing}: ${messageOf(cause)}` }),
  })

/** Write a new file whole, flushed, with `mode` (the file it replaces keeps its own); a name taken fails `EEXIST`. */
const writeSynced = (file: string, bytes: Uint8Array, mode: number | undefined) => call(() => open(file, "wx", mode).then((handle) => handle.writeFile(bytes).then(() => handle.sync()).then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
)))

/** Flush a folder's entries after a rename, so it outlives a power loss; a file system that cannot is passed over. */
const syncFolder = (folder: string) => call(() => open(folder, "r").then((handle) => handle.sync().then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
))).pipe(Effect.catch((cause) => Effect.logDebug(`the folder ${folder} could not be flushed`, cause)))

/**
 * A workspace in a folder of the disk (ADR 0028): `Files` over `node:fs`, on Node 24 and Bun.
 *
 * - **Paths stay in the root.** A `FilePath` holds no `..`, and every path's real path (links followed) must be in the
 *   root's, or the call is declined (`FilesRefused`, "it leads outside the workspace"). A new file's nearest folder
 *   that exists is checked before any folder is made, so a link to a folder outside cannot be written through.
 * - **Text is UTF-8.** A file that is not is declined in words, never read with replacement characters (an edit would
 *   write them back over the bytes it could not read). A byte-order mark is kept as the character it is.
 * - **A file over `maxBytes`** is declined, read or written.
 * - **A write is whole**: the text goes to a temporary file in the file's folder (`.efferent-<uuid>.tmp`, never
 *   listed), flushed, then renamed over the file, which keeps its mode; a crash leaves the old file or the new one,
 *   and perhaps a temporary file the listing passes over. A folder is made for a new file as needed.
 * - **Compare and set holds within the process**: the check of what a write expects and its rename take the
 *   workspace's lane, one write at a time for every `diskFiles` of the process over the same root. Another process
 *   that writes the file between the check and the rename is not seen: the write replaces its change. A person's
 *   editor that saves meanwhile is such a process.
 * - **`list`** walks the folder, ordered by code unit, and passes over: `ignore`'s names (and what is in them), a
 *   write's temporary files, a name that makes no `FilePath` (a `:`, a `\`, a control character, a path over
 *   `PATH_LIMIT`), and a link that leads outside the root, to nothing, or back to itself. A link to a file in the root
 *   is listed; a link to a folder is not walked, so a loop of links never is.
 *
 * Not a sandbox against the machine: a process that swaps a folder for a link between a check and a write can still
 * lead a write out. The check holds a model's paths to the root. Each call is one span, `disk_files.<call>`.
 *
 * @public
 */
export const diskFiles = (options: DiskFilesOptions): Layer.Layer<Files, FilesUnavailable> => Layer.effect(Files, Effect.gen(function* () {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const ignore: ReadonlySet<string> = new Set(options.ignore ?? DEFAULT_IGNORE)
  if (!Number.isInteger(maxBytes) || maxBytes < 1) return yield* Effect.die(new Error(`diskFiles: maxBytes must be a whole number of at least 1, not ${maxBytes}`))
  const badName = Array.from(ignore).find((name) => name.length === 0 || name.includes("/") || name.includes("\\"))
  if (badName !== undefined) return yield* Effect.die(new Error(`diskFiles: ignore holds names, not paths: ${JSON.stringify(badName)}`))
  const root = yield* call(() => realpath(options.root)).pipe(Effect.mapError((cause) => new FilesUnavailable({ message: `the workspace ${options.root} cannot be opened: ${messageOf(cause)}` })))
  const rootInfo = yield* call(() => stat(root)).pipe(Effect.mapError((cause) => new FilesUnavailable({ message: `the workspace ${options.root} cannot be opened: ${messageOf(cause)}` })))
  if (!rootInfo.isDirectory()) return yield* Effect.fail(new FilesUnavailable({ message: `the workspace ${options.root} is not a folder` }))
  const lane = laneOf(root)
  const inside = (real: string) => isInside(root, real, sep)
  const outside = (path: FilePath) => new FilesRefused({ path, reason: "it leads outside the workspace", message: `${path} leads outside ${root}` })
  const tooLarge = (path: FilePath, bytes: number) =>
    new FilesRefused({ path, reason: `it is ${bytes} bytes, more than the ${maxBytes} this workspace takes`, message: `${path} is ${bytes} bytes` })

  /** A file's real path in the root, or why there is none. */
  const realFile = (path: FilePath) => Effect.gen(function* () {
    const real = yield* Effect.mapError(call(() => realpath(join(root, path))), failureOf(path, "read"))
    if (!inside(real)) return yield* Effect.fail(outside(path))
    return real
  })

  /** A file's text, if it is a file of the root that is not too large and is UTF-8. */
  const textOf = (path: FilePath, real: string) => Effect.gen(function* () {
    const info = yield* Effect.mapError(call(() => stat(real)), failureOf(path, "read"))
    if (!info.isFile()) return yield* Effect.fail(new FileNotFound({ path, message: `no file is at ${path}: a folder is` }))
    if (info.size > maxBytes) return yield* Effect.fail(tooLarge(path, info.size))
    const bytes = yield* Effect.mapError(call(() => readFile(real)), failureOf(path, "read"))
    if (bytes.length > maxBytes) return yield* Effect.fail(tooLarge(path, bytes.length))
    return yield* Effect.try({
      try: () => decoder.decode(bytes),
      catch: () => new FilesRefused({ path, reason: "it is not UTF-8 text", message: `${path} is not UTF-8 text` }),
    })
  })

  /**
   * Where a write of `path` goes: the real path of the file there, with its mode; or, for a new file, a path under
   * the nearest folder that exists, checked in the root first, whose missing folders are then made.
   */
  const targetOf = (path: FilePath) => Effect.gen(function* () {
    const found = yield* call(() => realpath(join(root, path))).pipe(
      Effect.map(Option.some),
      Effect.catch((cause) => isAbsence(cause) ? Effect.succeed(Option.none<string>()) : Effect.fail(failureOf(path, "written")(cause))),
    )
    if (Option.isSome(found)) {
      if (!inside(found.value)) return yield* Effect.fail(outside(path))
      const info = yield* Effect.mapError(call(() => stat(found.value)), failureOf(path, "written"))
      if (!info.isFile()) return yield* Effect.fail(new FilesRefused({ path, reason: "a folder is at that path", message: `${path} is a folder` }))
      return { file: found.value, mode: Option.some(info.mode & 0o7777) }
    }
    // Nothing is there; but a link that leads to nothing is, and is not followed.
    const link = yield* call(() => lstat(join(root, path))).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
    if (link) return yield* Effect.fail(new FilesRefused({ path, reason: "it is a link that leads to nothing", message: `${path} is a dangling link` }))
    const names = path.split("/")
    for (let kept = names.length - 1; kept >= 0; kept -= 1) {
      const folder = join(root, ...names.slice(0, kept))
      const real = yield* call(() => realpath(folder)).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) => isAbsence(cause) ? Effect.succeed(Option.none<string>()) : Effect.fail(failureOf(path, "written")(cause))),
      )
      if (Option.isNone(real)) continue
      if (real.value !== root && !inside(real.value)) return yield* Effect.fail(outside(path))
      const info = yield* Effect.mapError(call(() => stat(real.value)), failureOf(path, "written"))
      if (!info.isDirectory()) {
        return yield* Effect.fail(new FilesRefused({ path, reason: `a file is where a folder must be (${names.slice(0, kept).join("/")})`, message: `${path} has a file for a folder` }))
      }
      const rest = names.slice(kept)
      if (rest.length > 1) yield* Effect.mapError(call(() => mkdir(join(real.value, ...rest.slice(0, -1)), { recursive: true })), failureOf(path, "written"))
      return { file: join(real.value, ...rest), mode: Option.none<number>() }
    }
    return yield* Effect.die(new Error(`diskFiles: the root ${root} was not found under ${path}`))
  })

  /** Whether the file at `target` holds what a write expects. */
  const meets = (path: FilePath, file: string, exists: boolean, expected: Expected) => Effect.gen(function* () {
    if (expected._tag === "Absent") return !exists
    if (!exists) return false
    return yield* textOf(path, file).pipe(
      Effect.map((text) => text === expected.text),
      Effect.catchTags({ FilesRefused: () => Effect.succeed(false), FileNotFound: () => Effect.succeed(false) }),
    )
  })

  /** Walk a folder of the root: the paths of the files in it and its folders, as `prefix` names them. */
  const walk = (real: string, prefix: string): Effect.Effect<ReadonlyArray<FilePath>, FilesUnavailable> => Effect.gen(function* () {
    const entries = yield* call(() => readdir(real, { withFileTypes: true })).pipe(
      Effect.catch((cause) => Option.match(errorCodeOf(cause), {
        onNone: () => Effect.fail(new FilesUnavailable({ message: `the folder ${real} could not be listed: ${messageOf(cause)}` })),
        onSome: (code) => ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code)
          ? Effect.succeed<ReadonlyArray<Dirent>>([])
          : Effect.fail(new FilesUnavailable({ message: `the folder ${real} could not be listed: ${messageOf(cause)}` })),
      })),
    )
    const found = yield* Effect.forEach(entries, (entry) => {
      const name = String(entry.name)
      const path = prefix.length === 0 ? name : `${prefix}/${name}`
      if (ignore.has(name) || isTempName(name) || !isFilePath(path)) return Effect.succeed<ReadonlyArray<FilePath>>([])
      if (entry.isDirectory()) return walk(join(real, name), path)
      if (entry.isFile()) return Effect.succeed<ReadonlyArray<FilePath>>([path])
      if (!entry.isSymbolicLink()) return Effect.succeed<ReadonlyArray<FilePath>>([])
      // A link is listed when it leads to a file of the root; one to a folder is not walked, so no loop is.
      return call(() => realpath(join(real, name)).then((target) => stat(target).then((info) => ({ target, file: info.isFile() })))).pipe(
        Effect.map(({ target, file }): ReadonlyArray<FilePath> => file && inside(target) ? [path] : []),
        Effect.catch(() => Effect.succeed<ReadonlyArray<FilePath>>([])),
      )
    }, { concurrency: 1 })
    return found.flat()
  })

  return Files.of({
    read: Effect.fn("disk_files.read")(function* (path) {
      return yield* textOf(path, yield* realFile(path))
    }),
    list: Effect.fn("disk_files.list")(function* (folder) {
      const start = yield* Option.match(folder, {
        onNone: () => Effect.succeed(Option.some(root)),
        onSome: (name) => call(() => realpath(join(root, name))).pipe(
          Effect.map((real) => inside(real) ? Option.some(real) : Option.none()),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        ),
      })
      if (Option.isNone(start)) return []
      const paths = yield* walk(start.value, Option.match(folder, { onNone: () => "", onSome: (name) => name }))
      return Arr.sort(paths, Order.String)
    }),
    write: Effect.fn("disk_files.write")(function* (path, text, expected) {
      const bytes = encoder.encode(text)
      if (bytes.length > maxBytes) return yield* Effect.fail(tooLarge(path, bytes.length))
      return yield* lane.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
        const target = yield* targetOf(path)
        if (expected !== undefined && !(yield* meets(path, target.file, Option.isSome(target.mode), expected))) {
          return yield* Effect.fail(new FileChanged({ path, message: `${path} does not hold what the write expected` }))
        }
        const temporary = join(dirname(target.file), tempNameOf(randomUUID()))
        yield* Effect.mapError(writeSynced(temporary, bytes, Option.getOrUndefined(target.mode)), failureOf(path, "written"))
        yield* call(() => rename(temporary, target.file)).pipe(
          Effect.mapError(failureOf(path, "written")),
          Effect.tapError(() => call(() => unlink(temporary)).pipe(Effect.catch((cause) => Effect.logWarning(`a temporary file could not be removed: ${temporary}`, cause)))),
        )
        yield* syncFolder(dirname(target.file))
      }))).pipe(Effect.catchTag("FileNotFound", (missing) => Effect.fail(new FilesUnavailable({ message: missing.message }))))
    }),
  })
}))
