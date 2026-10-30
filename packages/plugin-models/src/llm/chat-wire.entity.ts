import { Schema } from "effect"
import { ToolCallId } from "@xandreed/core"

/**
 * The OpenAI-compatible chat-completions wire, as the compat client reads
 * it. Every field may be absent or `null` (gateways send both); a field of
 * the wrong type is a provider protocol failure, reported as an
 * `InvalidResponseError` rather than as the model's malformed output.
 */

const Count = Schema.optionalKey(Schema.NullOr(Schema.Number))
const Text = Schema.optionalKey(Schema.NullOr(Schema.String))

/** The usage object OpenAI-compatible completions carry (streaming sends it
 *  on the last chunk under `stream_options: {include_usage: true}`). */
export const CompletionUsage = Schema.Struct({
  prompt_tokens: Count,
  completion_tokens: Count,
  total_tokens: Count,
  /** DeepSeek-style cache accounting. */
  prompt_cache_hit_tokens: Count,
  /** Moonshot-style cache accounting. */
  cached_tokens: Count,
  /** OpenAI-native cache reads; gateways (OpenCode's among them) add the cache writes. */
  prompt_tokens_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ cached_tokens: Count, cache_write_tokens: Count }))),
  /** OpenAI-native reasoning accounting, counted inside `completion_tokens`. */
  completion_tokens_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reasoning_tokens: Count }))),
})
export type CompletionUsage = typeof CompletionUsage.Type

/** A tool call's id as the wire carries it: absent, `null` or the provider's id. */
const WireToolCallId = Schema.optionalKey(Schema.NullOr(ToolCallId))
const ToolCallFunction = Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Text, arguments: Text })))

/** A message's text and reasoning fields: DeepSeek-native `reasoning_content`
 *  (kimi-k2.7-code, deepseek serve this) or OpenRouter-style `reasoning`
 *  (kimi-k2.6 via Moonshot serves this). */
const MessageText = { content: Text, reasoning_content: Text, reasoning: Text }

/** One non-streaming chat completion. */
export const ChatCompletion = Schema.Struct({
  choices: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({
    finish_reason: Text,
    message: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      ...MessageText,
      tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ id: WireToolCallId, function: ToolCallFunction })))),
    }))),
  })))),
  usage: Schema.optionalKey(Schema.NullOr(CompletionUsage)),
})
export type ChatCompletion = typeof ChatCompletion.Type

/** A streamed tool-call fragment: fragments of one call share its `index`. */
export const StreamToolCall = Schema.Struct({ index: Count, id: WireToolCallId, function: ToolCallFunction })
export type StreamToolCall = typeof StreamToolCall.Type

/** One `data:` chunk of a streaming chat completion. */
export const StreamChunk = Schema.Struct({
  choices: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({
    finish_reason: Text,
    delta: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      ...MessageText,
      tool_calls: Schema.optionalKey(Schema.NullOr(Schema.Array(StreamToolCall))),
    }))),
  })))),
  usage: Schema.optionalKey(Schema.NullOr(CompletionUsage)),
  error: Schema.optionalKey(Schema.Unknown),
})
export type StreamChunk = typeof StreamChunk.Type

/** The OpenAI error object a gateway reports a failure with: its type, its code and its message. */
export const GatewayError = Schema.Struct({
  type: Text,
  code: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  message: Text,
})
export type GatewayError = typeof GatewayError.Type

/** A failed request's body in the OpenAI error shape. */
export const GatewayErrorBody = Schema.Struct({ error: GatewayError })
