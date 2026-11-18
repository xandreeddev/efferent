// The wire of an OpenAI-compatible chat-completions endpoint (OpenAI, Gemini's OpenAI-compatible endpoint, the Vercel
// AI Gateway's `/v1/chat/completions`), the fields read of it. The learn track's gateway wire
// (`packages/website/src/learn/models/gateway-wire.ts`) is the shape this follows, read from DeepSeek V4.1 Flash on
// Baseten through the gateway on 2026-11-16: each chunk is `{ choices: [{ delta, finish_reason }], usage? }`; a delta
// holds `content` (text), `tool_calls` (a call's id and name in its first piece, its arguments as text across pieces,
// by `index`) and `reasoning` (the model's own thinking, not read); the last chunk holds `usage`, with `cost` and the
// cached input tokens when the gateway answers.
import { Schema } from "effect"

/** One message of the wire. */
export type WireMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: ReadonlyArray<WireCall> }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string }

/** A tool call the model made, as the wire sends it back in the assistant's message. */
export interface WireCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

/** A tool offered, as the wire declares it. */
export interface WireTool {
  readonly type: "function"
  readonly function: { readonly name: string; readonly description: string; readonly parameters: unknown }
}

/** A number a provider may send as a number or as text (the gateway's `cost`). */
const Amount = Schema.Union([Schema.Finite, Schema.FiniteFromString])
const Count = Schema.optional(Schema.NullOr(Schema.Finite))

/** A tool call's id as the provider gave it: the id the call's result answers. */
export const WireCallId = Schema.String.pipe(Schema.brand("WireCallId"))

const Delta = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({
    index: Schema.Finite,
    id: Schema.optional(Schema.NullOr(WireCallId)),
    function: Schema.optional(Schema.NullOr(Schema.Struct({
      name: Schema.optional(Schema.NullOr(Schema.String)),
      arguments: Schema.optional(Schema.NullOr(Schema.String)),
    }))),
  })))),
})

/** What a provider counted for one answer, and what it billed when it says (the gateway's `cost`, in USD). */
export const WireUsage = Schema.Struct({
  prompt_tokens: Count,
  completion_tokens: Count,
  cost: Schema.optional(Schema.NullOr(Amount)),
  prompt_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ cached_tokens: Count, cache_write_tokens: Count }))),
  completion_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ reasoning_tokens: Count }))),
})
export type WireUsage = typeof WireUsage.Type

/** One chunk of the stream, the fields read; anything else in it is passed over. */
export const WireChunk = Schema.Struct({
  choices: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({
    delta: Schema.optional(Schema.NullOr(Delta)),
    finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
  })))),
  usage: Schema.optional(Schema.NullOr(WireUsage)),
})
export type WireChunk = typeof WireChunk.Type

/** A chunk sent in place of the answer's next piece when the provider failed part way: `{ error: … }`. */
export const ErrorChunk = Schema.Struct({ error: Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) }) })

/** What one answer's stream has read so far: whether text started, its calls by index, how it finished and its usage. */
export interface Reading {
  readonly text: boolean
  readonly calls: ReadonlyMap<number, { readonly id: string; readonly name: string; readonly args: string }>
  readonly finish: string | undefined
  readonly usage: WireUsage | undefined
}

/** The fields a request is made of, which a host's own body fields (`extra`) may not replace. */
export const REQUEST_FIELDS: ReadonlyArray<string> = [
  "model", "messages", "tools", "tool_choice", "stream", "stream_options", "max_tokens", "max_completion_tokens", "response_format",
]
