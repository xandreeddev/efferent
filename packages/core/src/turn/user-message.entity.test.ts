import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { mediaFromBase64, mediaFromBytes, mediaLabel } from "../domain/media.entity.functions.js"
import { MEDIA_LIMITS, MediaFingerprint } from "../domain/media.entity.js"
import { normalizeUserMessage, sameUserMessage, userMessageOf, userMessageText, userRoleMessageOf } from "./user-message.entity.functions.js"
import { UserMessage } from "./user-message.entity.js"

const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const pixel = Effect.runSync(mediaFromBase64(pixelPng, { name: "pixel.png" }))

/** A PNG header padded to `size` bytes. */
const pngOf = (size: number): Uint8Array => {
  const file = new Uint8Array(size)
  file.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 4])
  return file
}

describe("a user message", () => {
  test("has text, images or both; whitespace alone is still text, as before; nothing at all is refused", () => {
    expect(new UserMessage({ text: "", attachments: [pixel] }).attachments?.length).toBe(1)
    expect(new UserMessage({ text: "  " }).text).toBe("  ")
    expect(Option.isNone(Schema.decodeUnknownOption(UserMessage)({ text: "" }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(UserMessage)({ text: "hi", attachments: [] }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(UserMessage)({ text: "hi", attachments: Array.from({ length: MEDIA_LIMITS.attachments + 1 }, () => pixel) }))).toBe(true)
  })

  test("as text: its text, then one label line per image", () => {
    expect(userMessageText(new UserMessage({ text: "plain" }))).toBe("plain")
    expect(userMessageText(new UserMessage({ text: "look", attachments: [pixel] }))).toBe(`look\n${mediaLabel(pixel)}`)
    expect(userMessageText(new UserMessage({ text: "", attachments: [pixel, pixel] }))).toBe(`${mediaLabel(pixel)}\n${mediaLabel(pixel)}`)
  })

  test("is the same message when its text and its images' fingerprints, types, sizes, names and alts are", () => {
    const base = new UserMessage({ text: "look", attachments: [pixel] })
    expect(sameUserMessage(base, new UserMessage({ text: "look", attachments: [{ ...pixel }] }))).toBe(true)
    expect(sameUserMessage(base, new UserMessage({ text: "look" }))).toBe(false)
    expect(sameUserMessage(base, new UserMessage({ text: "look", attachments: [{ ...pixel, name: "other.png" }] }))).toBe(false)
    expect(sameUserMessage(base, new UserMessage({ text: "look", attachments: [pixel, pixel] }))).toBe(false)
  })
})

describe("normalizing a user message", () => {
  test("a text-only message is returned as it is", async () => {
    const message = new UserMessage({ text: "hello" })
    expect(await Effect.runPromise(normalizeUserMessage(message))).toBe(message)
  })

  test("each image is checked again from its data: a wrong fingerprint, type or size is corrected", async () => {
    const wrong = { ...pixel, mediaType: "image/gif" as const, bytes: 3, fingerprint: MediaFingerprint.make("0123456789abcdef") }
    const normalized = await Effect.runPromise(normalizeUserMessage(new UserMessage({ text: "look", attachments: [wrong] })))
    expect(normalized.attachments).toEqual([pixel])
    expect(sameUserMessage(normalized, new UserMessage({ text: "look", attachments: [pixel] }))).toBe(true)
  })

  test("an attachment that is not an image is refused with its position; images over requestChars together are refused", async () => {
    const notImage = { ...pixel, data: "aGVsbG8gd29ybGQ=" }
    const refused = await Effect.runPromise(Effect.flip(normalizeUserMessage(new UserMessage({ text: "look", attachments: [pixel, notImage] }))))
    expect([refused.reason, refused.index]).toEqual(["UnsupportedType", 1])
    const largest = await Effect.runPromise(mediaFromBytes(pngOf(MEDIA_LIMITS.imageBytes)))
    const count = Math.floor(MEDIA_LIMITS.requestChars / largest.data.length) + 1
    const together = await Effect.runPromise(Effect.flip(normalizeUserMessage(new UserMessage({ text: "", attachments: Array.from({ length: count }, () => largest) }))))
    expect(together.reason).toBe("TooLargeTogether")
  })
})

describe("raw user-role conversion", () => {
  test("text, image-only and mixed messages round-trip exactly without changing image bytes or metadata", () => {
    const messages = [new UserMessage({ text: "  keep whitespace\n" }), new UserMessage({ text: "", attachments: [pixel] }), new UserMessage({ text: "look", attachments: [pixel, { ...pixel, name: "second.png", alt: "the other pixel" }] })]
    messages.forEach((message) => {
      expect(userMessageOf(userRoleMessageOf(message))).toEqual(Option.some(message))
    })
    expect(userRoleMessageOf(messages[0]!)).toEqual({ role: "user", content: "  keep whitespace\n" })
    expect(userRoleMessageOf(messages[1]!)).toEqual({ role: "user", content: [pixel] })
    expect(userRoleMessageOf(messages[2]!)).toEqual({ role: "user", content: [pixel, { ...pixel, name: "second.png", alt: "the other pixel" }, { type: "text", text: "look" }] })
    expect(Option.map(userMessageOf(userRoleMessageOf(messages[1]!)), (message) => message.attachments?.[0])).toEqual(Option.some(pixel))
  })

  test("an empty raw message cannot invent user intent; split text retains its exact characters", () => {
    expect(userMessageOf({ role: "user", content: "" })).toEqual(Option.none())
    expect(userMessageOf({ role: "user", content: [] })).toEqual(Option.none())
    expect(userMessageOf({ role: "user", content: [{ type: "text", text: "a\n" }, pixel, { type: "text", text: " b" }] })).toEqual(Option.some(new UserMessage({ text: "a\n b", attachments: [pixel] })))
  })
})
