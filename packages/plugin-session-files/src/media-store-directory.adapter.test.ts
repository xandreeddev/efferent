import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Context, Effect, Fiber, Layer, Option } from "effect"
import { MEDIA_LIMITS, MediaHash, mediaHashOf, MediaStore } from "@xandreed/core"
import { mediaStoreConformance } from "@xandreed/core/conformance"
import { MediaStoreDirectoryLive } from "./media-store-directory.adapter.js"
import type { MediaStoreDirectoryOptions } from "./media-store-directory.adapter.js"
import { nodeFilesIo } from "./files-io.adapter.js"

const temporary = () => Effect.acquireRelease(Effect.tryPromise(() => mkdtemp(join(tmpdir(), "efferent-media-kit-"))), root => Effect.tryPromise(() => rm(root, { recursive: true, force: true })).pipe(Effect.orDie))
mediaStoreConformance({ open: () => Effect.gen(function* () {
  const root = yield* temporary()
  return Context.get(yield* Layer.build(MediaStoreDirectoryLive(root)), MediaStore)
}) }).forEach(check => test(check.name, async () => {
  const result = await Effect.runPromise(Effect.result(check.run))
  expect(result._tag === "Failure" ? result.failure.message : "ok").toBe("ok")
}))

const open = (root: string, options?: MediaStoreDirectoryOptions) => Layer.build(MediaStoreDirectoryLive(root, options)).pipe(Effect.map(context => Context.get(context, MediaStore)))
const gate = () => {
  const callback: { resolve?: () => void } = {}
  const promise = new Promise<void>(resolve => { callback.resolve = resolve })
  return { promise, resolve: () => callback.resolve!() }
}
const input = () => new Uint8Array([0, 255, 128, 1, 2])

test("put copies a Buffer before held IO and get returns independent bytes after reopening", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const entered = gate()
    const release = gate()
    const store = yield* open(root, { io: { ...nodeFilesIo, create: (path, bytes) => path.endsWith(".tmp")
      ? Promise.resolve().then(() => { entered.resolve(); return release.promise }).then(() => nodeFilesIo.create(path, bytes)) : nodeFilesIo.create(path, bytes) } })
    const bytes = Buffer.from(input())
    const putting = yield* Effect.forkChild(store.put(bytes))
    yield* Effect.tryPromise(() => entered.promise)
    bytes.fill(9)
    release.resolve()
    const key = yield* Fiber.join(putting)
    expect(key).toBe(mediaHashOf(input()))
    const reopened = yield* open(root)
    const first = yield* reopened.get(key)
    expect(Option.getOrThrow(first)).toEqual(input())
    Option.getOrThrow(first).fill(9)
    expect(Option.getOrThrow(yield* reopened.get(key))).toEqual(input())
  })).pipe(Effect.timeout("2 seconds")))
})

test("independent concurrent publishers converge through EEXIST and use private immutable files", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const release = gate()
    const links: string[] = []
    const io = { ...nodeFilesIo, link: (from: string, to: string) => !to.endsWith(".bin") ? nodeFilesIo.link(from, to) : Promise.resolve().then(() => {
      links.push(to)
      if (links.length === 2) release.resolve()
      return release.promise
    }).then(() => nodeFilesIo.link(from, to)) }
    const a = yield* open(root, { io })
    const b = yield* open(root, { io })
    const hashes = yield* Effect.all([a.put(input()), b.put(input())], { concurrency: 2 })
    expect(hashes[0]).toBe(hashes[1]!)
    expect(links).toHaveLength(2)
    expect(yield* Effect.tryPromise(() => readdir(join(root, "blobs")))).toEqual([`${hashes[0]}.bin`])
    expect((yield* Effect.tryPromise(() => stat(join(root, "blobs", `${hashes[0]}.bin`)))).mode & 0o777).toBe(0o600)
    expect((yield* Effect.tryPromise(() => stat(join(root, "blobs")))).mode & 0o777).toBe(0o700)
    expect(yield* Effect.tryPromise(() => readdir(join(root, "tmp")))).toEqual([])
  })).pipe(Effect.timeout("2 seconds")))
})

test("a lost blob publication acknowledgment is settled from immutable bytes", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const original = Object.assign(new Error("link answer lost"), { code: "EIO" })
    const store = yield* open(root, { io: { ...nodeFilesIo, link: (from, to) => nodeFilesIo.link(from, to).then(() => to.endsWith(".bin") ? Promise.reject(original) : undefined) } })
    const key = yield* store.put(input())
    expect(Option.getOrThrow(yield* store.get(key))).toEqual(input())
    expect(yield* store.put(input())).toBe(key)
    expect(yield* Effect.tryPromise(() => readdir(join(root, "blobs")))).toHaveLength(1)
  })))
})

test("corrupt and oversized final files fail closed without overwriting evidence", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const lengths: number[] = []
    const store = yield* open(root, { io: { ...nodeFilesIo, readStart: (path, length) => { if (path.endsWith(".bin")) lengths.push(length); return nodeFilesIo.readStart(path, length) } } })
    const key = mediaHashOf(input())
    const path = join(root, "blobs", `${key}.bin`)
    const damaged = new Uint8Array([7])
    yield* Effect.tryPromise(() => writeFile(path, damaged))
    const read = yield* Effect.result(store.get(key))
    const put = yield* Effect.result(store.put(input()))
    expect(read._tag === "Failure" && read.failure.reason).toBe("Corrupt")
    expect(put._tag === "Failure" && put.failure.reason).toBe("Corrupt")
    expect(new Uint8Array(yield* Effect.tryPromise(() => readFile(path)))).toEqual(damaged)
    yield* Effect.tryPromise(() => writeFile(path, new Uint8Array(MEDIA_LIMITS.imageBytes + 1)))
    const large = yield* Effect.result(store.get(key))
    expect(large._tag === "Failure" && large.failure.reason).toBe("Corrupt")
    expect(lengths).toEqual([MEDIA_LIMITS.imageBytes + 1, MEDIA_LIMITS.imageBytes + 1, MEDIA_LIMITS.imageBytes + 1])
  })))
})

test("failed publication retains the original IO cause and exposes no final blob", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const original = Object.assign(new Error("link refused"), { code: "EACCES" })
    const store = yield* open(root, { io: { ...nodeFilesIo, link: (from, to) => to.endsWith(".bin") ? Promise.reject(original) : nodeFilesIo.link(from, to) } })
    const result = yield* Effect.result(store.put(input()))
    expect(result._tag === "Failure" && result.failure.reason).toBe("Unavailable")
    expect(result._tag === "Failure" && result.failure.cause).toBe(original)
    expect(Option.isNone(yield* store.get(mediaHashOf(input())))).toBe(true)
    expect(yield* Effect.tryPromise(() => readdir(join(root, "tmp")))).toEqual([])
  })))
})

test("unsupported media markers and hard-link failures preserve separate session marker bytes", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const sessionMarker = '{"layout":1}\n'
    const future = '{"layout":2,"algorithm":"sha256"}\n'
    yield* Effect.tryPromise(() => writeFile(join(root, "store.json"), sessionMarker))
    yield* Effect.tryPromise(() => writeFile(join(root, "media-store.json"), future))
    const result = yield* Effect.result(open(root))
    expect(result._tag === "Failure" && result.failure.reason).toBe("Unavailable")
    expect(yield* Effect.tryPromise(() => readFile(join(root, "media-store.json"), "utf8"))).toBe(future)
    expect(yield* Effect.tryPromise(() => readFile(join(root, "store.json"), "utf8"))).toBe(sessionMarker)
    const other = yield* temporary()
    const failure = Object.assign(new Error("no hard links"), { code: "ENOTSUP" })
    const unavailable = yield* Effect.result(open(other, { io: { ...nodeFilesIo, link: () => Promise.reject(failure) } }))
    expect(unavailable._tag === "Failure" && unavailable.failure.reason).toBe("Unavailable")
    expect(unavailable._tag === "Failure" && unavailable.failure.cause).toBe(failure)
  })))
})

test("invalid keys never become paths and invalid deadlines make no file call", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const reads: string[] = []
    const store = yield* open(root, { io: { ...nodeFilesIo, readStart: (path, length) => { reads.push(path); return nodeFilesIo.readStart(path, length) } } })
    const before = reads.length
    const bad = yield* Effect.result(store.get("../outside" as MediaHash))
    expect(bad._tag === "Failure" && bad.failure.reason).toBe("Invalid")
    expect(reads.length).toBe(before)
    const folders: string[] = []
    const invalid = yield* Effect.result(open(root, { stallMs: 0, io: { ...nodeFilesIo, mkdir: path => { folders.push(path); return nodeFilesIo.mkdir(path) } } }))
    expect(invalid._tag === "Failure" && invalid.failure.reason).toBe("Invalid")
    expect(folders).toEqual([])
  })))
})

test("cancelling a pending blob put is prompt and leaves no committed final reference", async () => {
  const entered = gate()
  const release = gate()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const store = yield* open(root, { stallMs: 80, io: { ...nodeFilesIo, create: (path, bytes) => !path.endsWith(".tmp") ? nodeFilesIo.create(path, bytes)
      : Promise.resolve().then(() => { entered.resolve(); return release.promise }).then(() => nodeFilesIo.create(path, bytes)) } })
    const fiber = yield* Effect.forkChild(store.put(input()))
    yield* Effect.tryPromise(() => entered.promise)
    const prompt = yield* Effect.raceFirst(Fiber.interrupt(fiber).pipe(Effect.as(true)), Effect.sleep(10).pipe(Effect.as(false)))
    release.resolve()
    expect(prompt).toBe(true)
    expect(yield* Effect.tryPromise(() => readdir(join(root, "blobs")))).toEqual([])
  })).pipe(Effect.ensuring(Effect.sync(() => release.resolve())), Effect.timeout("2 seconds")))
})

test("base typed-array copies cannot be changed by byteLength or iterator overrides", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const root = yield* temporary()
    const reads: string[] = []
    const store = yield* open(root, { io: { ...nodeFilesIo, readStart: (path, count) => { reads.push(path); return nodeFilesIo.readStart(path, count) } } })
    const empty = Object.defineProperty(new Uint8Array(), "byteLength", { value: 1 })
    const before = reads.length
    const refused = yield* Effect.result(store.put(empty))
    expect(refused._tag === "Failure" && refused.failure.reason).toBe("Invalid")
    expect(reads.length).toBe(before)
    const actual = new Uint8Array([9])
    Object.defineProperty(actual, Symbol.iterator, { value: () => [][Symbol.iterator]() })
    const hash = yield* store.put(actual)
    expect(hash).toBe(mediaHashOf(new Uint8Array([9])))
    expect(Option.getOrThrow(yield* store.get(hash))).toEqual(new Uint8Array([9]))
  })))
})
