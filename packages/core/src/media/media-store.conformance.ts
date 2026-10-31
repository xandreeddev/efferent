import { Effect, Option } from "effect"
import type { Scope } from "effect"
import { check, expect } from "../conformance.functions.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { MEDIA_LIMITS } from "../domain/media.entity.js"
import { MediaHash } from "../domain/media-store.entity.js"
import type { MediaStore } from "../ports/media-store.port.js"

/** Each check opens a fresh blob store without preexisting values. @public */
export interface MediaStoreSubject {
  readonly open: () => Effect.Effect<MediaStore["Service"], unknown, Scope.Scope>
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])
const bytes = () => new Uint8Array([0, 255, 128, 1, 2])
const vectors = [
  { bytes: [0], hash: "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d" },
  { bytes: [97, 98, 99], hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  { bytes: [0, 255, 128, 1, 2], hash: "e1017891a8dc2b5398c02204fb0280bcb139a3b31da234b1b38ac3e86a3f39ad" },
]

/** The bounded immutable byte-store promises, shared by memory and directory adapters. @public */
export const mediaStoreConformance = (subject: MediaStoreSubject): ReadonlyArray<ConformanceCheck> => [
  check("keys are SHA-256 of exact binary bytes", "hash", () => Effect.scoped(Effect.gen(function* () {
    const store = yield* subject.open()
    yield* Effect.forEach(vectors, (vector) => store.put(new Uint8Array([123, ...vector.bytes, 124]).subarray(1, vector.bytes.length + 1)).pipe(
      Effect.flatMap((hash) => expect("hash", hash === vector.hash, "the content key is not the independent binary SHA-256 vector")),
    ), { concurrency: 1 })
  }))),
  check("put and get round-trip exact bytes", "roundtrip", () => Effect.scoped(Effect.gen(function* () {
    const store = yield* subject.open()
    const input = bytes()
    const found = yield* store.get(yield* store.put(input))
    yield* expect("roundtrip", Option.isSome(found) && sameBytes(found.value, input), "the stored bytes are absent or changed")
  }))),
  check("equal puts are idempotent and distinct bytes retain independent values", "idempotent", () => Effect.scoped(Effect.gen(function* () {
    const store = yield* subject.open()
    const first = yield* store.put(bytes())
    const again = yield* store.put(bytes())
    const otherBytes = new Uint8Array([4, 3, 2, 1])
    const other = yield* store.put(otherBytes)
    const found = yield* store.get(first)
    const second = yield* store.get(other)
    yield* expect("idempotent", first === again && first !== other && Option.isSome(found) && sameBytes(found.value, bytes()) && Option.isSome(second) && sameBytes(second.value, otherBytes), "put replaced an immutable value or used unstable/colliding keys")
  }))),
  check("an absent hash returns None", "missing", () => Effect.scoped(Effect.gen(function* () {
    const store = yield* subject.open()
    yield* store.put(bytes())
    const found = yield* store.get(MediaHash.make("0".repeat(64)))
    yield* expect("missing", Option.isNone(found), "an absent blob was fabricated")
  }))),
  check("put detaches bytes from the caller's buffer", "input-copy", () => Effect.scoped(Effect.gen(function* () {
    const store = yield* subject.open()
    const input = bytes()
    const key = yield* store.put(input)
    input.fill(9)
    const found = yield* store.get(key)
    yield* expect("input-copy", Option.isSome(found) && sameBytes(found.value, bytes()), "mutating the input changed stored bytes")
  }))),
  check("each get returns an independent byte buffer", "output-copy", () => Effect.scoped(Effect.gen(function* () {
    const store = yield* subject.open()
    const key = yield* store.put(bytes())
    const first = yield* store.get(key)
    if (Option.isSome(first)) first.value.fill(9)
    const second = yield* store.get(key)
    yield* expect("output-copy", Option.isSome(first) && Option.isSome(second) && first.value !== second.value && sameBytes(second.value, bytes()), "a returned buffer aliases stored data or another read")
  }))),
  check("the byte-store edge accepts its maximum and rejects empty or oversized values", "bounds", () => Effect.scoped(Effect.gen(function* () {
    const store = yield* subject.open()
    yield* Effect.forEach([new Uint8Array(), new Uint8Array(MEDIA_LIMITS.imageBytes + 1)], (input) => store.put(input).pipe(
      Effect.result,
      Effect.flatMap((result) => expect("bounds", result._tag === "Failure" && result.failure.reason === "Invalid", "out-of-bounds bytes did not fail as Invalid")),
    ), { concurrency: 1 })
    const input = new Uint8Array(MEDIA_LIMITS.imageBytes)
    input[0] = 1
    input[input.length - 1] = 255
    const found = yield* store.get(yield* store.put(input))
    yield* expect("bounds", Option.isSome(found) && sameBytes(found.value, input), "a maximum-size blob was refused or changed")
  }))),
]
