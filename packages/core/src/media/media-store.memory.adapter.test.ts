import { expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import type { MediaHash } from "../domain/media-store.entity.js"
import { mediaHashOf } from "../domain/media-store.entity.functions.js"
import { MEDIA_LIMITS } from "../domain/media.entity.js"
import { MediaStore } from "../ports/media-store.port.js"
import { mediaStoreConformance } from "./media-store.conformance.js"
import { MediaStoreMemoryLive } from "./media-store.memory.adapter.js"

test.each([...mediaStoreConformance({ open: () => Effect.service(MediaStore).pipe(Effect.provide(MediaStoreMemoryLive)) })])("memory: $name", async (check) => {
  await Effect.runPromise(check.run)
})

test("concurrent equal and distinct puts retain immutable independent values", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const store = yield* MediaStore
    const values = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([1, 2, 3])]
    const keys = yield* Effect.forEach(values, store.put, { concurrency: 3 })
    const found = yield* Effect.forEach(keys, store.get, { concurrency: 3 })
    return { values, keys, found }
  }).pipe(Effect.provide(MediaStoreMemoryLive)))
  expect(result.keys[0]).toBe(result.keys[2]!)
  expect(result.keys[0]).not.toBe(result.keys[1]!)
  expect(result.found.map((value) => Option.isSome(value) ? Array.from(value.value) : [])).toEqual(result.values.map((value) => Array.from(value)))
})

test("a typed-array view with an aliasing slice cannot retain access to stored bytes", async () => {
  class AliasingBytes extends Uint8Array {
    override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> { return new Uint8Array(this.buffer, this.byteOffset, this.byteLength).subarray(start, end) }
  }
  const result = await Effect.runPromise(Effect.gen(function* () {
    const store = yield* MediaStore
    const input = new AliasingBytes([1, 2, 3])
    const key = yield* store.put(input)
    input.fill(9)
    return yield* store.get(key)
  }).pipe(Effect.provide(MediaStoreMemoryLive)))
  expect(Option.isSome(result) ? Array.from(result.value) : []).toEqual([1, 2, 3])
})

test("independent memory layers share no stored blob state", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const first = yield* Effect.service(MediaStore).pipe(Effect.provide(Layer.fresh(MediaStoreMemoryLive)))
    const other = yield* Effect.service(MediaStore).pipe(Effect.provide(Layer.fresh(MediaStoreMemoryLive)))
    const key = yield* first.put(new Uint8Array([1]))
    return yield* other.get(key)
  }))
  expect(result).toEqual(Option.none())
})

test("an unchecked malformed get key fails as Invalid without being treated as missing", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const store = yield* MediaStore
    return yield* store.get("../invalid" as MediaHash).pipe(Effect.result)
  }).pipe(Effect.provide(MediaStoreMemoryLive)))
  expect(result._tag === "Failure" ? result.failure.reason : "success").toBe("Invalid")
})

test("empty/oversized size-liars, proxies and detached buffers fail as typed Invalid", async () => {
  class Misreported extends Uint8Array {
    override get byteLength() { return 1 }
    override get length() { return 1 }
  }
  const buffer = new ArrayBuffer(1)
  const detached = new Uint8Array(buffer)
  structuredClone(buffer, { transfer: [buffer] })
  const inputs = [new Misreported(0), new Misreported(MEDIA_LIMITS.imageBytes + 1), new Proxy(new Uint8Array([1]), {}), detached]
  const result = await Effect.runPromise(Effect.gen(function* () {
    const store = yield* MediaStore
    return yield* Effect.forEach(inputs, (input) => store.put(input).pipe(Effect.result), { concurrency: 1 })
  }).pipe(Effect.provide(MediaStoreMemoryLive)))
  expect(result.map((value) => value._tag === "Failure" ? value.failure.reason : "success")).toEqual(["Invalid", "Invalid", "Invalid", "Invalid"])
})

test("a valid size-liar is copied and hashed by its actual byte window", async () => {
  class Misreported extends Uint8Array {
    override get byteLength() { return 99 }
    override get length() { return 99 }
  }
  const result = await Effect.runPromise(Effect.gen(function* () {
    const store = yield* MediaStore
    const hash = yield* store.put(new Misreported([1, 2, 3]))
    return { hash, bytes: yield* store.get(hash) }
  }).pipe(Effect.provide(MediaStoreMemoryLive)))
  expect(result.hash).toBe(mediaHashOf(new Uint8Array([1, 2, 3])))
  expect(Option.isSome(result.bytes) ? Array.from(result.bytes.value) : []).toEqual([1, 2, 3])
})
