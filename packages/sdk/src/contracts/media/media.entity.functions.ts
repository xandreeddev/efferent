import { Result, Schema } from "effect"
import { MediaHash, MediaRefused } from "./media.entity.js"

/** SHA-256's initial hash and round constants (FIPS 180-4). */
const initialHash: ReadonlyArray<number> = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const rounds = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/**
 * The key of `bytes` in a media store (ADR 0034): their SHA-256, pure, so a page with no secure context (where
 * `crypto.subtle` is missing) hashes as a process does. The state lives in typed arrays updated in place per block,
 * so a few megabytes hash in tens of milliseconds; a store on a platform with native crypto may hash with it instead,
 * to the same key.
 *
 * @public
 */
export const mediaHashOf = (bytes: Uint8Array): MediaHash => {
  const size = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(size)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000))
  view.setUint32(size - 4, (bytes.length * 8) >>> 0)
  const hash = Uint32Array.from(initialHash)
  const schedule = new Uint32Array(64)
  const state = new Uint32Array(8)
  for (let offset = 0; offset < size; offset += 64) {
    for (let index = 0; index < 16; index++) schedule[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index++) {
      const early = schedule[index - 15]!, late = schedule[index - 2]!
      schedule[index] = schedule[index - 16]! + (rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3)) + schedule[index - 7]! + (rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10))
    }
    state.set(hash)
    for (let index = 0; index < 64; index++) {
      const a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!, e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + rounds[index]! + schedule[index]!) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      state[7] = g
      state[6] = f
      state[5] = e
      state[4] = d + t1
      state[3] = c
      state[2] = b
      state[1] = a
      state[0] = t1 + t2
    }
    for (let index = 0; index < 8; index++) hash[index] = hash[index]! + state[index]!
  }
  return MediaHash.make(Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join(""))
}

/**
 * A typed array's own window, read with the intrinsic getters: a subclass's `byteLength`, `length` or `buffer` that
 * says otherwise, and a proxy (no typed array at all to the intrinsics), cannot change what is copied.
 */
const windowOf = (value: unknown): Result.Result<{ readonly buffer: ArrayBufferLike; readonly offset: number; readonly length: number }, string> => {
  if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value)) return Result.fail("it is no Uint8Array")
  const read = (name: "buffer" | "byteOffset" | "byteLength"): unknown => Reflect.get(Uint8Array.prototype, name, value)
  const buffer = read("buffer")
  const offset = read("byteOffset")
  const length = read("byteLength")
  if (!(buffer instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer))) return Result.fail("its buffer is no ArrayBuffer")
  if (typeof offset !== "number" || typeof length !== "number") return Result.fail("its window cannot be read")
  return Result.succeed({ buffer, offset, length })
}

/**
 * Bytes a store may keep, as a copy of their own, made before the store waits for anything, or why they are refused:
 * no bytes (`empty`, a buffer handed away included, which holds none), more than `maxBytes` (`size`), or a value that
 * is no byte array of its own (`bytes`: not a `Uint8Array`, a proxy of one). The copy reads the array's own window
 * whatever a subclass says of it, so the caller's buffer, changed later, changes nothing kept.
 *
 * @public
 */
export const checkedBytes = (value: unknown, maxBytes: number): Result.Result<Uint8Array, MediaRefused> => Result.match(windowOf(value), {
  onFailure: (why) => Result.fail(new MediaRefused({ reason: "bytes", message: `The media is not bytes a store can keep: ${why}.` })),
  onSuccess: ({ buffer, offset, length }) => {
    if (length === 0) return Result.fail(new MediaRefused({ reason: "empty", message: "The media holds no bytes." }))
    if (length > maxBytes) return Result.fail(new MediaRefused({ reason: "size", message: `The media is ${length} bytes, more than the ${maxBytes} this store keeps under one key.` }))
    const copy = new Uint8Array(length)
    copy.set(new Uint8Array(buffer, offset, length))
    return Result.succeed(copy)
  },
})

const isMediaHash = Schema.is(MediaHash)

/** A key a store may look for, or why it is refused: anything but 64 lowercase hexadecimal digits never reaches a path. */
export const checkedKey = (value: unknown): Result.Result<MediaHash, MediaRefused> =>
  isMediaHash(value) ? Result.succeed(value) : Result.fail(new MediaRefused({ reason: "key", message: "A media key is the SHA-256 of the bytes, as 64 lowercase hexadecimal digits." }))

/** Whether a store's bound is one: a whole number of 1 or more. */
export const isBound = (maxBytes: number): boolean => Number.isInteger(maxBytes) && maxBytes >= 1

/** Whether two byte arrays hold the same bytes. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])
