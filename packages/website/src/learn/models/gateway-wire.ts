// The wire of an OpenAI-compatible chat endpoint (the Vercel AI Gateway's `/v1/chat/completions`), as pure functions:
// what a prompt and its tools become in a request's body, and what each streamed chunk becomes in `effect/ai`'s
// stream parts. No key, no fetch and no page here: gateway.ts sends the request; the kernel's model providers can use
// these functions as they are.
//
// What the stream looks like, as read on 2026-11-16 from DeepSeek V4.1 Flash on Baseten through the gateway: each
// chunk is `{ choices: [{ delta, finish_reason }], usage? }`; a delta holds `content` (text), `tool_calls` (a call's
// id and name in its first piece, its arguments as text across pieces, by `index`), and `reasoning` (the model's own
// thinking, which the page does not show); the last chunk holds `usage` with `cost` and the cached input tokens.
import { Option, Predicate, Schema } from "effect"
import type { Prompt, Response, Tool } from "effect/ai"
import { Tool as Tools } from "effect/ai"

/** The gateway's base address. Fixed in code: never taken from what a page or a person types. */
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1"

/** One message of the wire. */
export type WireMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: ReadonlyArray<WireCall> }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string }

export interface WireCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

export interface WireTool {
  readonly type: "function"
  readonly function: { readonly name: string; readonly description: string; readonly parameters: unknown }
}

const textOf = (parts: ReadonlyArray<{ readonly type: string }>): string =>
  parts.flatMap((part) => (part.type === "text" && Predicate.hasProperty(part, "text") && Predicate.isString(part.text) ? [part.text] : [])).join("")

/** A tool's result as the text the model reads: a string as it is, anything else as JSON. */
const resultText = (result: unknown): string => (Predicate.isString(result) ? result : JSON.stringify(result) ?? "null")

/** A prompt as the wire's messages: text kept, each call with its id, each result answering its call's id. */
export const wireMessages = (prompt: Prompt.Prompt): ReadonlyArray<WireMessage> =>
  prompt.content.flatMap((message): ReadonlyArray<WireMessage> => {
    switch (message.role) {
      case "system":
        return message.content.length > 0 ? [{ role: "system", content: message.content }] : []
      case "user": {
        const content = textOf(message.content)
        return content.length > 0 ? [{ role: "user", content }] : []
      }
      case "assistant": {
        const content = textOf(message.content)
        const calls = message.content.flatMap((part): ReadonlyArray<WireCall> =>
          part.type === "tool-call" ? [{ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.params) ?? "{}" } }] : [])
        if (content.length === 0 && calls.length === 0) return []
        return [{ role: "assistant", content: content.length > 0 ? content : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) }]
      }
      case "tool":
        return message.content.flatMap((part): ReadonlyArray<WireMessage> =>
          part.type === "tool-result" ? [{ role: "tool", tool_call_id: part.id, content: resultText(part.result) }] : [])
    }
  })

/** The tools offered, as the wire declares them: name, description and the JSON schema of their parameters. */
export const wireTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<WireTool> =>
  tools.map((tool) => ({ type: "function", function: { name: tool.name, description: Tools.getDescription(tool) ?? "", parameters: Tools.getJsonSchema(tool) } }))

export interface RequestOptions {
  /** The gateway's id of the model, `creator/model`. */
  readonly model: string
  /** Providers to try first, in order; others may answer when these are busy (the gateway's `order`). */
  readonly order: ReadonlyArray<string>
  /**
   * Requests of one conversation share it, so a provider that caches by key reads their shared start from its cache.
   * Opaque: a random id, never a name.
   */
  readonly cacheKey: string
  readonly maxTokens: number
}

/**
 * The body of one streamed request. The model's own reasoning is left as the model has it: the page shows none of it,
 * but turning it off made DeepSeek V4.1 Flash garble four answers in five (words dropped mid-sentence), and none with
 * it on. `max_tokens` leaves room for the reasoning before the answer.
 */
export const requestBody = (prompt: Prompt.Prompt, tools: ReadonlyArray<Tool.Any>, options: RequestOptions) => ({
  model: options.model,
  messages: wireMessages(prompt),
  ...(tools.length > 0 ? { tools: wireTools(tools) } : {}),
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: options.maxTokens,
  prompt_cache_key: options.cacheKey,
  ...(options.order.length > 0 ? { providerOptions: { gateway: { order: options.order } } } : {}),
})

// ── reading the stream ────────────────────────────────────────────────────────

const Delta = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({
    index: Schema.Number,
    id: Schema.optional(Schema.NullOr(Schema.String)),
    function: Schema.optional(Schema.NullOr(Schema.Struct({
      name: Schema.optional(Schema.NullOr(Schema.String)),
      arguments: Schema.optional(Schema.NullOr(Schema.String)),
    }))),
  })))),
})
const WireUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.NullOr(Schema.Number)),
  prompt_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optional(Schema.NullOr(Schema.Number)) }))),
  completion_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.NullOr(Schema.Number)) }))),
})
/** One chunk of the stream, the fields read; anything else in it is passed over. */
export const WireChunk = Schema.Struct({
  choices: Schema.optional(Schema.Array(Schema.Struct({
    delta: Schema.optional(Schema.NullOr(Delta)),
    finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
  }))),
  usage: Schema.optional(Schema.NullOr(WireUsage)),
})
export type WireChunk = typeof WireChunk.Type

/** A chunk's text, as the stream's `data:` line holds it, decoded; none for a line that is no chunk. */
export const chunkOf = (data: string): Option.Option<WireChunk> => Schema.decodeUnknownOption(Schema.fromJsonString(WireChunk))(data)

/** The finish reasons the wire gives, in `effect/ai`'s words. */
const finishReason = (reason: string | undefined): Response.FinishReason =>
  reason === "stop" ? "stop" : reason === "length" ? "length" : reason === "tool_calls" ? "tool-calls" : reason === "content_filter" ? "content-filter" : reason === undefined ? "unknown" : "other"

/** What one answer's stream has read so far: its text, its calls by index, how it finished and what it cost. */
export interface Reading {
  readonly text: boolean
  readonly calls: ReadonlyMap<number, { readonly id: string; readonly name: string; readonly args: string }>
  readonly finish: Option.Option<string>
  readonly usage: Option.Option<typeof WireUsage.Type>
}
export const startReading: Reading = { text: false, calls: new Map(), finish: Option.none(), usage: Option.none() }

/**
 * One chunk read: the parts it hands on now (text as it comes), and what is kept for the end (a call's pieces, the
 * finish, the usage). A call is handed on whole at the end: its arguments arrive in pieces, and the loop runs a call
 * with all of them.
 */
export const readChunk = (reading: Reading, chunk: WireChunk): { readonly reading: Reading; readonly parts: ReadonlyArray<Response.StreamPartEncoded> } => {
  const parts: Array<Response.StreamPartEncoded> = []
  let text = reading.text
  const calls = new Map(reading.calls)
  let finish = reading.finish
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta
    if (delta?.content !== undefined && delta.content !== null && delta.content.length > 0) {
      if (!text) parts.push({ type: "text-start", id: "text" })
      text = true
      parts.push({ type: "text-delta", id: "text", delta: delta.content })
    }
    for (const call of delta?.tool_calls ?? []) {
      const known = calls.get(call.index) ?? { id: "", name: "", args: "" }
      calls.set(call.index, {
        id: known.id || (call.id ?? ""),
        name: known.name || (call.function?.name ?? ""),
        args: known.args + (call.function?.arguments ?? ""),
      })
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = Option.some(choice.finish_reason)
  }
  const usage = chunk.usage !== undefined && chunk.usage !== null ? Option.some(chunk.usage) : reading.usage
  return { reading: { text, calls, finish, usage }, parts }
}

/** A call's arguments as the model wrote them: an object when they read as JSON, else the text as it came. */
const paramsOf = (args: string): unknown =>
  Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(args.length > 0 ? args : "{}"), () => args)

/** What the provider counted, in `effect/ai`'s usage. */
export const usageOf = (usage: Option.Option<typeof WireUsage.Type>) => Option.match(usage, {
  onNone: () => ({ inputTokens: {}, outputTokens: {} }),
  onSome: (one) => {
    const cached = one.prompt_tokens_details?.cached_tokens ?? undefined
    return {
      inputTokens: {
        ...(one.prompt_tokens !== undefined ? { total: one.prompt_tokens } : {}),
        ...(cached !== undefined ? { cacheRead: cached } : {}),
        ...(one.prompt_tokens !== undefined && cached !== undefined ? { uncached: one.prompt_tokens - cached } : {}),
      },
      outputTokens: {
        ...(one.completion_tokens !== undefined ? { total: one.completion_tokens } : {}),
        ...(one.completion_tokens_details?.reasoning_tokens !== undefined && one.completion_tokens_details.reasoning_tokens !== null ? { reasoning: one.completion_tokens_details.reasoning_tokens } : {}),
      },
    }
  },
})

/** The stream's end: the text closed, each call whole, in the order the model asked, then the finish with the usage. */
export const endReading = (reading: Reading): ReadonlyArray<Response.StreamPartEncoded> => [
  ...(reading.text ? [{ type: "text-end", id: "text" } as const] : []),
  ...[...reading.calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]): Response.StreamPartEncoded => ({ type: "tool-call", id: call.id, name: call.name, params: paramsOf(call.args), providerExecuted: false })),
  { type: "finish", reason: finishReason(Option.getOrUndefined(reading.finish)), usage: usageOf(reading.usage) },
]

/** What one answer cost, in dollars, as the gateway reported it; none when it did not say. */
export const costOf = (reading: Reading): Option.Option<number> =>
  Option.flatMap(reading.usage, (usage) => Option.fromNullishOr(usage.cost))
