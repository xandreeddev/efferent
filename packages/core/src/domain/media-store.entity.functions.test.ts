import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { MEDIA_LIMITS } from "./media.entity.js"
import { MediaHash, MediaStoreBytes, MediaStoreError } from "./media-store.entity.js"
import { mediaHashOf } from "./media-store.entity.functions.js"

test("media hashes are checked lowercase SHA-256 values", () => {
  const hash = mediaHashOf(new Uint8Array([97, 98, 99]))
  expect(hash).toBe(MediaHash.make("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
  expect([hash, hash.toUpperCase(), hash.slice(1), `${hash}0`, "g".repeat(64)].map((value) => Option.isSome(Schema.decodeUnknownOption(MediaHash)(value)))).toEqual([true, false, false, false, false])
})

test("the public hash helper hashes decoded bytes and subarray windows without applying store bounds", () => {
  expect(mediaHashOf(new Uint8Array())).toBe(MediaHash.make("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))
  expect(mediaHashOf(new Uint8Array([9, 97, 98, 99, 8]).subarray(1, 4))).toBe(mediaHashOf(new Uint8Array([97, 98, 99])))
  const large = new Uint8Array(MEDIA_LIMITS.imageBytes + 1)
  expect(Option.isSome(Schema.decodeUnknownOption(MediaHash)(mediaHashOf(large)))).toBe(true)
  const png = Schema.decodeUnknownSync(Schema.Uint8ArrayFromBase64)("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
  expect(mediaHashOf(png)).toBe(MediaHash.make("497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581"))
})

test("the byte edge keeps its minimum and maximum and rejects empty or larger input", () => {
  expect([0, 1, MEDIA_LIMITS.imageBytes, MEDIA_LIMITS.imageBytes + 1].map((size) => Option.isSome(Schema.decodeUnknownOption(MediaStoreBytes)(new Uint8Array(size))))).toEqual([false, true, true, false])
  const cause = new Error("original")
  expect(new MediaStoreError({ reason: "Corrupt", message: "corrupt", cause }).cause).toBe(cause)
})

test("the byte edge uses native size rather than subclass length accessors", () => {
  class Misreported extends Uint8Array {
    override get byteLength() { return 1 }
    override get length() { return 1 }
  }
  expect([0, 3, MEDIA_LIMITS.imageBytes + 1].map((size) => Option.isSome(Schema.decodeUnknownOption(MediaStoreBytes)(new Misreported(size))))).toEqual([false, true, false])
})
