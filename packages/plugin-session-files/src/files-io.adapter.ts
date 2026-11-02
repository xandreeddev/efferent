import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises"
import { Option } from "effect"
import { errorCodeOf } from "@xandreed/core"

/**
 * The file system calls the store makes, each one promise: a seam a test
 * replaces to make a call hang, fail or pause at a named point. Not a
 * service: a constructor option of the store, like `SessionsLive`'s
 * `liveness`.
 *
 * @public
 */
export interface FilesIo {
  /** Create a directory and its parents (owner only); one that exists is fine. */
  readonly mkdir: (path: string) => Promise<void>
  /** Create a new file with `bytes` (owner only), flushed to the disk before it answers; one that exists fails `EEXIST`. */
  readonly create: (path: string, bytes: Uint8Array) => Promise<void>
  readonly link: (from: string, to: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly read: (path: string) => Promise<Uint8Array>
  /** The file's first bytes, up to `length` (all of them when the file is that long, however many reads it takes). */
  readonly readStart: (path: string, length: number) => Promise<Uint8Array>
  readonly list: (path: string) => Promise<ReadonlyArray<string>>
  /** Whether the path exists; a missing one answers false, any other failure rejects. */
  readonly exists: (path: string) => Promise<boolean>
  readonly unlink: (path: string) => Promise<void>
  /** Remove a directory and everything in it. */
  readonly removeTree: (path: string) => Promise<void>
  /** Flush a directory's entries to the disk; a file system that cannot answers an error the store ignores. */
  readonly syncDirectory: (path: string) => Promise<void>
}

const missing = (error: unknown): boolean => Option.contains(errorCodeOf(error), "ENOENT")

/** One positioned read: it may answer fewer bytes than asked (an interrupted call, a network or FUSE mount). */
export type ReadAt = (buffer: Uint8Array, offset: number, length: number, position: number) => Promise<{ readonly bytesRead: number }>

/** The first `length` bytes of a file, reading again after a short answer until the buffer is full or the file ends. */
export const readFully = (read: ReadAt, length: number): Promise<Uint8Array> => {
  const buffer = new Uint8Array(length)
  const from = (offset: number): Promise<number> => offset >= length ? Promise.resolve(offset)
    : read(buffer, offset, length - offset, offset).then(({ bytesRead }) => bytesRead === 0 ? offset : from(offset + bytesRead))
  return from(0).then((filled) => buffer.subarray(0, filled))
}

/**
 * The store's calls on the local machine's file system (`node:fs/promises`), on Node and Bun.
 *
 * @public
 */
export const nodeFilesIo: FilesIo = {
  mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
  create: (path, bytes) => open(path, "wx", 0o600).then((handle) => handle.writeFile(bytes).then(() => handle.sync()).then(
    () => handle.close(),
    (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
  )),
  link: (from, to) => link(from, to),
  rename: (from, to) => rename(from, to),
  read: (path) => readFile(path),
  readStart: (path, length) => open(path, "r").then((handle) => readFully((buffer, offset, size, position) => handle.read(buffer, offset, size, position), length).then(
    (bytes) => handle.close().then(() => bytes),
    (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
  )),
  list: (path) => readdir(path),
  exists: (path) => stat(path).then(() => true, (error: unknown) => missing(error) ? false : Promise.reject(error)),
  unlink: (path) => unlink(path),
  removeTree: (path) => rm(path, { recursive: true, force: true }),
  syncDirectory: (path) => open(path, "r").then((handle) => handle.sync().then(
    () => handle.close(),
    (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
  )),
}
