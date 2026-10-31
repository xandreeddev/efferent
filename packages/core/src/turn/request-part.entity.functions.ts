import { Effect, Schema } from "effect"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import { ModelRequestHeader } from "./model-request.entity.js"
import { ModelRequestHeaderV2 } from "./model-request-header.entity.js"
import { RequestPart, RequestPartData } from "./request-part.entity.js"

type Words = readonly [number, number, number, number, number, number, number, number]

/** SHA-256's initial hash and round constants (FIPS 180-4). */
const initialHash: Words = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const rounds: ReadonlyArray<number> = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))
const at = (words: ReadonlyArray<number>, index: number): number => words[index] ?? 0

/** SHA-256 of a text's UTF-8 bytes, in hex: pure, as the core has no platform crypto. */
export const sha256Of = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  const size = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(size)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000))
  view.setUint32(size - 4, (bytes.length * 8) >>> 0)
  const schedule = (block: number): ReadonlyArray<number> => Array.from({ length: 48 }, (_, index) => index + 16).reduce(
    (words: ReadonlyArray<number>, index) => {
      const early = at(words, index - 15)
      const late = at(words, index - 2)
      const s0 = rotr(early, 7) ^ rotr(early, 18) ^ (early >>> 3)
      const s1 = rotr(late, 17) ^ rotr(late, 19) ^ (late >>> 10)
      return [...words, (at(words, index - 16) + s0 + at(words, index - 7) + s1) >>> 0]
    },
    Array.from({ length: 16 }, (_, index) => view.getUint32(block * 64 + index * 4)),
  )
  const compress = (hash: Words, block: number): Words => {
    const [a, b, c, d, e, f, g, h] = schedule(block).reduce(([a, b, c, d, e, f, g, h]: Words, word, index): Words => {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + at(rounds, index) + word) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      return [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g]
    }, hash)
    return [(hash[0] + a) >>> 0, (hash[1] + b) >>> 0, (hash[2] + c) >>> 0, (hash[3] + d) >>> 0,
      (hash[4] + e) >>> 0, (hash[5] + f) >>> 0, (hash[6] + g) >>> 0, (hash[7] + h) >>> 0]
  }
  return Array.from({ length: size / 64 }, (_, block) => block).reduce(compress, initialHash)
    .map((word) => word.toString(16).padStart(8, "0")).join("")
}

const immutable = <A>(value: A): A => {
  if (typeof value !== "object" || value === null) return value
  Object.values(value).map(immutable)
  return Object.freeze(value)
}

/** Encode and copy before hashing: provider Options are null/object on the wire. */
export const encodeRequestPart = Effect.fnUntraced(function* (part: RequestPart): Effect.fn.Return<typeof RequestPartData.Encoded, Schema.SchemaError> {
  const encoded = yield* Schema.encodeEffect(RequestPart)(part)
  const json = yield* storedJson(encoded)
  const normalized = yield* Schema.decodeUnknownEffect(Schema.toEncoded(RequestPart))(json)
  return immutable({ hash: sha256Of(canonicalJson(json)), part: normalized })
})

/** Immutable encoded components for one full request; storage deduplicates against durable history. */
export const prepareRequestParts = Effect.fnUntraced(function* (header: ModelRequestHeader): Effect.fn.Return<{
  readonly header: typeof ModelRequestHeaderV2.Encoded
  readonly parts: ReadonlyArray<typeof RequestPartData.Encoded>
}, Schema.SchemaError> {
  const encoded = yield* Schema.encodeEffect(ModelRequestHeader)(header)
  const json = yield* storedJson(encoded)
  const copied = yield* Schema.decodeUnknownEffect(ModelRequestHeader)(json)
  const wire = yield* Schema.decodeUnknownEffect(Schema.toEncoded(ModelRequestHeader))(json)
  const system = yield* encodeRequestPart({ _tag: "System", text: copied.system })
  const tools = yield* Effect.forEach(copied.tools, (tool) => encodeRequestPart({ _tag: "Tool", tool }), { concurrency: 1 })
  const parts = [...new Map([system, ...tools].map((part) => [part.hash, part])).values()]
  const next: typeof ModelRequestHeaderV2.Encoded = { ...wire, version: 2, system: system.hash, tools: tools.map((part) => part.hash) }
  return immutable({ header: next, parts })
})
