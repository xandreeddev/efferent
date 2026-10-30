import { Option, Schema } from "effect"
import { TransformedMessageStart, TransformedResponse } from "./thinking-binding.entity.js"
import type { InputTransformation, ThinkingPrefixMismatch } from "./thinking-binding.entity.js"

/**
 * An `anthropic-beta` header with `betas` added: the values it holds first,
 * in order, then each new one once. Never a replacement: the client's own
 * betas (structured outputs, the subscription's) stay.
 */
export const mergeBetas = (existing: Option.Option<string>, betas: ReadonlyArray<string>): string => {
  const held = Option.match(existing, { onNone: () => [], onSome: (value) => value.split(",").map((beta) => beta.trim()).filter((beta) => beta.length > 0) })
  return [...held, ...betas].filter((beta, index, all) => all.indexOf(beta) === index).join(",")
}

/** The binding a request to a model carries: none for a model that does not bind, or with `provider-default`. */
export const bindingFor = (bindsThinking: boolean, mismatch: ThinkingPrefixMismatch): Option.Option<Exclude<ThinkingPrefixMismatch, "provider-default">> =>
  bindsThinking && mismatch !== "provider-default" ? Option.some(mismatch) : Option.none()

/** The reasons of the thinking blocks the provider dropped, one per block, in order. */
export const droppedReasonsOf = (transformations: ReadonlyArray<InputTransformation>): ReadonlyArray<string> =>
  transformations.filter((change) => change.type === "thinking_dropped").map((change) => change.reason ?? "unknown")

const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(TransformedResponse))
const decodeMessageStart = Schema.decodeUnknownOption(Schema.fromJsonString(TransformedMessageStart))

/** What a settled response's JSON body says the provider dropped; nothing when it is not that JSON. */
export const droppedInBody = (body: string): ReadonlyArray<string> =>
  Option.match(decodeResponse(body), { onNone: () => [], onSome: (response) => droppedReasonsOf(response.input_transformations ?? []) })

/**
 * The first event of a server-sent stream, when `text` (the stream so far)
 * holds it whole: its `data` lines joined. None until its blank line came.
 */
export const firstEventData = (text: string): Option.Option<string> => {
  const end = text.search(/\r?\n\r?\n/)
  if (end < 0) return Option.none()
  return Option.some(text.slice(0, end).split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"))
}

/** What a stream's `message_start` data says the provider dropped (on the event or its message); nothing for another event. */
export const droppedInMessageStart = (data: string): ReadonlyArray<string> =>
  Option.match(decodeMessageStart(data), {
    onNone: () => [],
    onSome: (event) => droppedReasonsOf([...(event.input_transformations ?? []), ...(event.message?.input_transformations ?? [])]),
  })
