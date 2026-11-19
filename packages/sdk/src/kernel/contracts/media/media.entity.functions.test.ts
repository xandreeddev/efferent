import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Option, Result } from "effect"
import { checkedBytes, checkedKey, mediaHashOf } from "./media.entity.functions.js"

const native = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("a media key", () => {
  test("is the SHA-256 of the bytes, as the platform's own gives it, at every length a block's padding turns on", () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, at) => (at * 31 + 7) % 256)
      expect<string>(mediaHashOf(bytes)).toBe(native(bytes))
    }
    expect<string>(mediaHashOf(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("of a few megabytes is the platform's too", () => {
    const bytes = Uint8Array.from({ length: 3_000_001 }, (_, at) => (at * 131) % 251)
    expect<string>(mediaHashOf(bytes)).toBe(native(bytes))
  })

  test("of a window is the window's, not its buffer's", () => {
    const window = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)
    expect<string>(mediaHashOf(window)).toBe(native(new Uint8Array([1, 2, 3])))
  })

  test("is refused when it is no 64 lowercase hexadecimal digits", () => {
    expect(["0".repeat(64), "a".repeat(64)].map((key) => Result.isSuccess(checkedKey(key)))).toEqual([true, true])
    expect(["A".repeat(64), "0".repeat(63), "../outside", "", 42].map((key) => Result.match(checkedKey(key), { onFailure: (refused) => refused.reason, onSuccess: () => "kept" }))).toEqual(["key", "key", "key", "key", "key"])
  })
})

describe("bytes a store may keep", () => {
  const reasonOf = (value: unknown, maxBytes = 8) => Result.match(checkedBytes(value, maxBytes), { onFailure: (refused) => refused.reason, onSuccess: () => "kept" })

  test("are 1 to the bound, a copy of their own: the caller's buffer, changed after, changes nothing", () => {
    const input = new Uint8Array([1, 2, 3])
    const copy = Result.getOrThrow(checkedBytes(input, 8))
    input.fill(9)
    expect(Array.from(copy)).toEqual([1, 2, 3])
    expect(copy.buffer).not.toBe(input.buffer)
    expect([reasonOf(new Uint8Array(0)), reasonOf(new Uint8Array(9)), reasonOf(new Uint8Array(8))]).toEqual(["empty", "size", "kept"])
  })

  test("a value that is no byte array of its own is refused: no Uint8Array, a proxy of one, an array of numbers", () => {
    expect([reasonOf([1, 2]), reasonOf("ab"), reasonOf(new Proxy(new Uint8Array([1]), {})), reasonOf(new Uint16Array([1])), reasonOf(null)]).toEqual(["bytes", "bytes", "bytes", "bytes", "bytes"])
  })

  test("a buffer handed away holds no bytes", () => {
    const buffer = new ArrayBuffer(4)
    const detached = new Uint8Array(buffer)
    structuredClone(buffer, { transfer: [buffer] })
    expect(reasonOf(detached)).toBe("empty")
  })

  test("a subclass that lies about its length is read by its own window, whatever it says", () => {
    class Misreported extends Uint8Array {
      override get byteLength() { return 1 }
      override get length() { return 1 }
    }
    expect(reasonOf(new Misreported(0))).toBe("empty")
    expect(reasonOf(new Misreported(9))).toBe("size")
    const kept = Result.getOrThrow(checkedBytes(new Misreported([1, 2, 3]), 8))
    expect(Array.from(kept)).toEqual([1, 2, 3])
  })

  test("a subclass whose slice aliases its buffer, or whose iterator lies, is copied all the same", () => {
    class Aliasing extends Uint8Array {
      override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> { return new Uint8Array(this.buffer as ArrayBuffer, this.byteOffset, this.byteLength).subarray(start, end) }
    }
    const input = new Aliasing([1, 2, 3])
    const kept = Result.getOrThrow(checkedBytes(input, 8))
    input.fill(9)
    expect(Array.from(kept)).toEqual([1, 2, 3])
    const lying = new Uint8Array([7])
    Object.defineProperty(lying, Symbol.iterator, { value: () => [][Symbol.iterator]() })
    expect(Option.some(Array.from(Result.getOrThrow(checkedBytes(lying, 8)).values()))).toEqual(Option.some([7]))
  })
})
