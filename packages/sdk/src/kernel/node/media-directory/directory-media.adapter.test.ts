import { describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Cause, Context, Effect, Fiber, Layer, Option } from "effect"
import { mediaStoreConformance } from "../../contracts/media/media.conformance.js"
import { mediaHashOf } from "../../contracts/media/media.entity.functions.js"
import type { MediaHash } from "../../contracts/media/media.entity.js"
import { MediaStore } from "../../contracts/media/media.port.js"
import { failedChecks, scratch } from "../testing.js"
import { directoryMedia } from "./directory-media.adapter.js"
import { temporaryName } from "./directory-media.entity.functions.js"

const BOUND = 4096

/** A store over a folder, built in the scope. */
const open = (directory: string, maxBytes = BOUND) => Effect.map(Layer.build(directoryMedia({ directory, maxBytes })), (services) => Context.get(services, MediaStore))

const input = () => new Uint8Array([0, 255, 128, 1, 2])
const run = <A, E>(body: (folder: string) => Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(Effect.flatMap(scratch, body)))
const listed = (folder: string) => Effect.promise(() => readdir(folder))

describe("a media store in a folder", () => {
  test("passes the media kit", async () => {
    expect(await failedChecks(mediaStoreConformance({ open: Effect.flatMap(scratch, (folder) => Effect.orDie(open(join(folder, "media")))) }))).toEqual([])
  })

  test("keeps what was put for the next store over the folder, readable by its owner alone; a get gives a copy of its own", async () => {
    await run((folder) => Effect.gen(function* () {
      const key = yield* (yield* open(folder)).put(input())
      const again = yield* open(folder)
      const first = yield* again.get(key)
      Option.map(first, (bytes) => bytes.fill(9))
      expect(Option.map(yield* again.get(key), (bytes) => Array.from(bytes))).toEqual(Option.some(Array.from(input())))
      expect((yield* Effect.promise(() => stat(join(folder, "blobs", key)))).mode & 0o777).toBe(0o600)
      expect(((yield* listed(folder)) as Array<string>).toSorted()).toEqual(["blobs", "damaged", "media.json", "tmp"])
      expect(JSON.parse(yield* Effect.promise(() => readFile(join(folder, "media.json"), "utf8")))).toEqual({ store: "efferent-media", layout: 1, algorithm: "sha256" })
    }))
  })

  test("bytes already kept are not written again, and two stores putting the same bytes at once converge on one blob", async () => {
    await run((folder) => Effect.gen(function* () {
      const [one, other] = yield* Effect.all([open(folder), open(folder)], { concurrency: 1 })
      const big = Uint8Array.from({ length: BOUND }, (_, at) => at % 251)
      const keys = yield* Effect.all([one.put(big), other.put(big), one.put(big)], { concurrency: 3 })
      expect(new Set(keys).size).toBe(1)
      expect(yield* listed(join(folder, "blobs"))).toEqual([keys[0]!])
      expect(yield* listed(join(folder, "tmp"))).toEqual([])
      const before = (yield* Effect.promise(() => stat(join(folder, "blobs", keys[0]!)))).mtimeMs
      yield* other.put(big)
      expect((yield* Effect.promise(() => stat(join(folder, "blobs", keys[0]!)))).mtimeMs).toBe(before)
    }))
  })

  test("a damaged blob is an error, never nothing; a put of its bytes keeps the damaged file and repairs it", async () => {
    await run((folder) => Effect.gen(function* () {
      const store = yield* open(folder)
      const key = mediaHashOf(input())
      const file = join(folder, "blobs", key)
      for (const damage of [new Uint8Array([7]), new Uint8Array(0), new Uint8Array(BOUND + 5)]) {
        yield* Effect.promise(() => writeFile(file, damage))
        const read = yield* Effect.flip(store.get(key))
        expect([read._tag, read._tag === "MediaDamaged" ? read.hash : ""]).toEqual(["MediaDamaged", key])
      }
      yield* Effect.promise(() => writeFile(file, new Uint8Array([7])))
      expect(yield* store.put(input())).toBe(key)
      expect(Array.from(yield* Effect.promise(() => readFile(file)))).toEqual(Array.from(input()))
      const damaged = yield* listed(join(folder, "damaged"))
      expect(damaged).toHaveLength(1)
      expect(Array.from(yield* Effect.promise(() => readFile(join(folder, "damaged", damaged[0]!))))).toEqual([7])
      expect(Option.map(yield* store.get(key), (bytes) => Array.from(bytes))).toEqual(Option.some(Array.from(input())))
      expect(yield* listed(join(folder, "tmp"))).toEqual([])
    }))
  })

  test("a temporary file a crash left is never read as a blob, and an opening removes it once it is an hour old", async () => {
    await run((folder) => Effect.gen(function* () {
      yield* open(folder)
      const key = mediaHashOf(input())
      const names = [
        temporaryName(key, 0, "00000000-0000-4000-8000-000000000001"),
        temporaryName("marker", 0, "00000000-0000-4000-8000-000000000002"),
        temporaryName(key, 9_999_999_999_999, "00000000-0000-4000-8000-000000000003"),
        "someone-elses-file",
      ]
      yield* Effect.forEach(names, (name) => Effect.promise(() => writeFile(join(folder, "tmp", name), input())), { concurrency: 1, discard: true })
      const store = yield* open(folder)
      expect(((yield* listed(join(folder, "tmp"))) as Array<string>).toSorted()).toEqual([names[2]!, names[3]!].toSorted())
      expect(yield* store.get(key)).toEqual(Option.none())
    }))
  })

  test("a folder holding other files and no marker, and a store of another layout, are refused and left as they are", async () => {
    await run((folder) => Effect.gen(function* () {
      const foreign = join(folder, "foreign")
      yield* Effect.promise(() => mkdir(foreign))
      yield* Effect.promise(() => writeFile(join(foreign, "notes.txt"), "mine"))
      const refused = yield* Effect.flip(open(foreign))
      expect(refused.message).toContain("holds other files (notes.txt) and no media.json")
      expect(yield* listed(foreign)).toEqual(["notes.txt"])
      const later = join(folder, "later")
      yield* Effect.promise(() => mkdir(later))
      const marker = `${JSON.stringify({ store: "efferent-media", layout: 2, algorithm: "sha256" })}\n`
      yield* Effect.promise(() => writeFile(join(later, "media.json"), marker))
      expect((yield* Effect.flip(open(later))).message).toContain("a store of another kind or layout")
      expect(yield* listed(later)).toEqual(["media.json"])
      expect(yield* Effect.promise(() => readFile(join(later, "media.json"), "utf8"))).toBe(marker)
    }))
  })

  test("a put interrupted at once publishes the blob whole or not at all, and leaves no temporary file", async () => {
    await run((folder) => Effect.gen(function* () {
      const store = yield* open(folder, 2_000_000)
      const big = Uint8Array.from({ length: 2_000_000 }, (_, at) => (at * 7) % 253)
      const fiber = yield* Effect.forkChild(store.put(big))
      yield* Fiber.interrupt(fiber)
      const blobs = yield* listed(join(folder, "blobs"))
      expect(blobs.length <= 1).toBe(true)
      for (const name of blobs) expect(Option.isSome(yield* store.get(name as MediaHash))).toBe(true)
      expect(yield* listed(join(folder, "tmp"))).toEqual([])
    }))
  })

  test("a process killed while it puts leaves every blob whole", async () => {
    await run((folder) => Effect.gen(function* () {
      yield* open(folder, 1_000_000)
      const script = join(folder, "putter.ts")
      const effect = Bun.resolveSync("effect", import.meta.dir)
      const adapter = join(import.meta.dir, "directory-media.adapter.ts")
      yield* Effect.promise(() => writeFile(script, `
import { Context, Effect, Layer } from ${JSON.stringify(effect)}
import { directoryMedia } from ${JSON.stringify(adapter)}
import { MediaStore } from ${JSON.stringify(join(import.meta.dir, "../../contracts/media/media.port.ts"))}
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const store = Context.get(yield* Layer.build(directoryMedia({ directory: ${JSON.stringify(folder)}, maxBytes: 1_000_000 })), MediaStore)
  for (let n = 0; ; n++) {
    yield* store.put(Uint8Array.from({ length: 1_000_000 }, (_, at) => (at + n) % 256))
    if (n === 0) process.stdout.write("put\\n")
  }
})))
`))
      const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "inherit" })
      const reader = child.stdout.getReader()
      yield* Effect.promise(() => reader.read())
      yield* Effect.sleep("150 millis")
      child.kill("SIGKILL")
      yield* Effect.promise(() => child.exited)
      const store = yield* open(folder, 1_000_000)
      const blobs = yield* listed(join(folder, "blobs"))
      expect(blobs.length).toBeGreaterThan(0)
      for (const name of blobs) expect(Option.isSome(yield* store.get(name as MediaHash))).toBe(true)
    }))
  }, 30_000)

  test("a bound that is no whole number of 1 or more dies where the layer is built", async () => {
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.flatMap(scratch, (folder) => open(folder, 0))))
    expect(exit._tag === "Failure" ? Cause.pretty(exit.cause) : "built").toContain("directoryMedia: maxBytes must be a whole number of at least 1, not 0")
  })
})
