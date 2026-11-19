import { Effect, Option } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck, ConformanceFailure } from "@xandreed/core/kernel"
import { expect, refuses, unexpected } from "../conformance.entity.functions.js"
import { MediaHash } from "./media.entity.js"
import { isBound, sameBytes } from "./media.entity.functions.js"
import type { MediaStore } from "./media.port.js"

type MediaStoreShape = Context.Service.Shape<typeof MediaStore>

/**
 * A media store as the kit opens it: a fresh, empty one per check, released with its scope. The kit puts a blob of
 * the store's `maxBytes`, so a subject checked often gives a store a small bound.
 *
 * @public
 */
export interface MediaStoreSubject {
  readonly open: Effect.Effect<MediaStoreShape, never, Scope.Scope>
}

/** Three byte strings and their SHA-256, worked out apart from any store (FIPS 180-4's own `abc` among them). */
const VECTORS: ReadonlyArray<{ readonly bytes: ReadonlyArray<number>; readonly hash: string }> = [
  { bytes: [0], hash: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d" },
  { bytes: [97, 98, 99], hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  { bytes: [0, 255, 128, 1, 2], hash: "e1017891a8dc2b5398c02204fb0280bcb139a3b31da234b1b38ac3e86a3f39ad" },
]

const first = () => new Uint8Array([0, 255, 128, 1, 2])
const second = () => new Uint8Array([4, 3, 2, 1])

/** The bytes a get gave, in words. */
const gave = (found: Option.Option<Uint8Array>): string =>
  Option.match(found, { onNone: () => "nothing", onSome: (bytes) => `${bytes.length} bytes [${Array.from(bytes.subarray(0, 8)).join(", ")}${bytes.length > 8 ? ", …" : ""}]` })

/** Whether a get gave exactly `bytes`. */
const gives = (found: Option.Option<Uint8Array>, bytes: Uint8Array): boolean => Option.exists(found, (got) => sameBytes(got, bytes))

const checks: ReadonlyArray<readonly [string, string, (store: MediaStoreShape) => Effect.Effect<void, ConformanceFailure>]> = [
  ["hash", "a put's key is the SHA-256 of exactly the bytes put, a window of a larger buffer included", (store) => Effect.forEach(VECTORS, (vector) => Effect.gen(function* () {
    // The bytes as a window in the middle of a larger buffer: a store hashes the window, not the buffer.
    const key = yield* store.put(new Uint8Array([123, ...vector.bytes, 124]).subarray(1, vector.bytes.length + 1))
    yield* expect("hash", key === vector.hash, `[${vector.bytes.join(", ")}] was put under ${key}, not its SHA-256 ${vector.hash}`)
  }), { concurrency: 1, discard: true }).pipe(unexpected("hash"))],
  ["again", "the same bytes put again give the same key, and keep what is there", (store) => Effect.gen(function* () {
    const once = yield* store.put(first())
    const twice = yield* store.put(first())
    yield* expect("again", once === twice, `the same bytes put twice gave ${once} and then ${twice}`)
    const found = yield* store.get(once)
    yield* expect("again", gives(found, first()), `after the same bytes were put twice, their key gave ${gave(found)}`)
  }).pipe(unexpected("again"))],
  ["apart", "bytes of two keys are each got back under their own key", (store) => Effect.gen(function* () {
    const one = yield* store.put(first())
    const other = yield* store.put(second())
    yield* expect("apart", one !== other, `two different byte strings were put under one key, ${one}`)
    const foundOne = yield* store.get(one)
    const foundOther = yield* store.get(other)
    yield* expect("apart", gives(foundOne, first()), `the first bytes' key gave ${gave(foundOne)}`)
    yield* expect("apart", gives(foundOther, second()), `the second bytes' key gave ${gave(foundOther)}`)
  }).pipe(unexpected("apart"))],
  ["missing", "a key nothing was put under gives nothing, and no failure", (store) => Effect.gen(function* () {
    yield* store.put(first())
    const found = yield* store.get(MediaHash.make("0".repeat(64)))
    yield* expect("missing", Option.isNone(found), `a key nothing was put under gave ${gave(found)}`)
  }).pipe(unexpected("missing"))],
  ["input-copy", "a put keeps a copy: the caller's buffer, changed after, changes nothing kept", (store) => Effect.gen(function* () {
    const input = first()
    const key = yield* store.put(input)
    input.fill(9)
    const found = yield* store.get(key)
    yield* expect("input-copy", gives(found, first()), `after the caller changed its buffer, the key gave ${gave(found)}`)
  }).pipe(unexpected("input-copy"))],
  ["output-copy", "each get gives a copy of its own: one changed changes neither the store nor the next get", (store) => Effect.gen(function* () {
    const key = yield* store.put(first())
    const one = yield* store.get(key)
    Option.map(one, (bytes) => bytes.fill(9))
    const other = yield* store.get(key)
    yield* expect("output-copy", gives(other, first()), `after a get's bytes were changed, the next get gave ${gave(other)}`)
    yield* expect("output-copy", Option.isSome(one) && Option.isSome(other) && one.value !== other.value, "two gets gave one buffer")
  }).pipe(unexpected("output-copy"))],
  ["bounds", "no bytes and more than maxBytes are refused; maxBytes bytes are kept", (store) => Effect.gen(function* () {
    yield* expect("bounds", isBound(store.maxBytes), `maxBytes is ${store.maxBytes}, not a whole number of 1 or more`)
    yield* refuses("bounds", "a put of no bytes", store.put(new Uint8Array(0)), (error) => error._tag === "MediaRefused" && error.reason === "empty")
    const over = new Uint8Array(store.maxBytes + 1).fill(7)
    yield* refuses("bounds", `a put of ${over.length} bytes`, store.put(over), (error) => error._tag === "MediaRefused" && error.reason === "size")
    const most = new Uint8Array(store.maxBytes).fill(7)
    most[0] = 1
    const kept = yield* store.get(yield* store.put(most))
    yield* expect("bounds", gives(kept, most), `a put of ${most.length} bytes, maxBytes, gave back ${gave(kept)}`)
  }).pipe(unexpected("bounds"))],
  ["key", "a key that is no SHA-256 in lowercase hexadecimal is refused, never looked for", (store) => Effect.forEach(["../outside", "A".repeat(64), "", "0".repeat(63)], (key) =>
    // A key from outside typed code: a host's request, a stored record. The cast is the caller's mistake the store meets.
    refuses("key", `a get of ${JSON.stringify(key)}`, Effect.suspend(() => store.get(key as MediaHash)), (error) => error._tag === "MediaRefused" && error.reason === "key"), { concurrency: 1, discard: true })],
]

/**
 * The `MediaStore` contract as checks (ADR 0034), each on a fresh store: a put's key is the SHA-256 of exactly the
 * bytes put (`hash`); the same bytes put again give the same key and keep what is there (`again`); bytes of two keys
 * are each got back under their own (`apart`); a key nothing was put under gives nothing (`missing`); a put keeps a
 * copy of the caller's buffer (`input-copy`), and each get gives a copy of its own (`output-copy`); no bytes and more
 * than `maxBytes` are refused, `maxBytes` bytes kept (`bounds`); a key that is no `MediaHash` is refused (`key`).
 *
 * @public
 */
export const mediaStoreConformance = (subject: MediaStoreSubject): ReadonlyArray<ConformanceCheck> =>
  checks.map(([id, name, run]) => ({ id, name, run: Effect.scoped(Effect.flatMap(subject.open, run)) }))
