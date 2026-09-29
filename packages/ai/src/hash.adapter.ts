import { Prompt } from "effect/ai"
import { Effect, Schema } from "effect"
import type { DecisionQuestions } from "./decision.entity.js"
import { PromptError } from "./prompt.entity.js"

const hex = (digest: ArrayBuffer): string => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")

/** SHA-256 of the text's UTF-8 bytes, lowercase hex (Web Crypto: Bun, Node and browsers alike). */
export const sha256Hex = (text: string): Effect.Effect<string, PromptError> => Effect.tryPromise({
  try: () => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  catch: (error) => new PromptError({ code: "hash.failed", message: String(error) }),
}).pipe(Effect.map(hex))

/** A model prompt's hash: SHA-256 hex of `JSON.stringify` of its encoded @effect/ai form. */
export const promptHash = (prompt: Prompt.Prompt): Effect.Effect<string, PromptError> => Schema.encodeEffect(Prompt.Prompt)(prompt).pipe(
  Effect.mapError((error) => new PromptError({ code: "hash.failed", message: error.message })),
  Effect.flatMap((encoded) => sha256Hex(JSON.stringify(encoded))),
)

/** A decision's hash: SHA-256 hex of `JSON.stringify({ state, questions })`. */
export const decisionHash = (state: string, questions: DecisionQuestions): Effect.Effect<string, PromptError> =>
  sha256Hex(JSON.stringify({ state, questions }))
