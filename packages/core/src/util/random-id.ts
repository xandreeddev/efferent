import { Effect, Random } from "effect"

const hex = (byte: number): string => byte.toString(16).padStart(2, "0")

/** Byte 6 carries the version (4), byte 8 the RFC 4122 variant. */
const stamped = (byte: number, index: number): number =>
  index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte

/**
 * A version-4 UUID drawn from the current `Random`, so a seeded one
 * (`Random.withSeed`) repeats it. For identities (a session, a bus, a kit's
 * fixtures), never secrets: a credential takes the platform's cryptographic
 * generator.
 */
export const randomUuid: Effect.Effect<string> = Effect.map(
  Effect.forEach(Array.from({ length: 16 }), () => Random.nextIntBetween(0, 255)),
  (bytes) => {
    const digits = bytes.map((byte, index) => hex(stamped(byte, index))).join("")
    return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`
  },
)
