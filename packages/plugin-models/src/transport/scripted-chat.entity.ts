import { Schema } from "effect"
import type { Effect, Option } from "effect"
import { ToolCallId } from "@xandreed/core"

/**
 * A script for an OpenAI-compatible chat-completions endpoint that runs in
 * the process: the replies a test or an evaluation wants the production
 * compat client to read, with no key and no network. `scriptedChatCompletions`
 * (`scripted-chat.adapter.ts`) answers requests with them.
 */

/**
 * Text a scripted reply sends: one string, split into fragments of the
 * step's `chunkSize` characters, or the fragments themselves, sent one per
 * chunk as they are.
 *
 * @public
 */
export const ScriptedText = Schema.Union([Schema.String, Schema.Array(Schema.String)])
export type ScriptedText = typeof ScriptedText.Type

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One tool call of a scripted reply. `arguments` is the arguments' JSON text
 * as the wire carries it (`JSON.stringify(input)`, or text that does not
 * parse, to test a model's malformed output). Without `id` the wire carries
 * none, as some gateways send.
 *
 * @public
 */
export const ScriptedToolCall = Schema.Struct({
  id: Schema.optionalKey(ToolCallId),
  name: Schema.NonEmptyString,
  arguments: ScriptedText,
})
export type ScriptedToolCall = typeof ScriptedToolCall.Type

/**
 * The usage a scripted reply reports: on its final chunk when it streams,
 * in its body when it does not. `promptTokens` counts the cached tokens and
 * `completionTokens` the reasoning ones, as the wire does.
 *
 * @public
 */
export const ScriptedUsage = Schema.Struct({
  promptTokens: TokenCount,
  completionTokens: TokenCount,
  cachedTokens: Schema.optionalKey(TokenCount),
  reasoningTokens: Schema.optionalKey(TokenCount),
})
export type ScriptedUsage = typeof ScriptedUsage.Type

/**
 * The finish reasons a scripted reply can end on, as the wire spells them.
 *
 * @public
 */
export const ScriptedFinishReason = Schema.Literals(["stop", "tool_calls", "length", "content_filter"])
export type ScriptedFinishReason = typeof ScriptedFinishReason.Type

/**
 * One scripted reply, as data (a script can be kept as JSON and decoded with
 * this schema). It sends `reasoning`, then `text`, then each tool call in
 * order. `finishReason` defaults to `tool_calls` when the reply makes a call
 * and `stop` otherwise. Without `usage` the reply reports none: the reader
 * sees unknown usage, never a measured zero. `chunkSize` (default
 * `SCRIPTED_CHUNK_SIZE`) is the characters per fragment a string is split
 * into. A step answers one request, unless `repeat` keeps it answering every
 * request it matches.
 *
 * @public
 */
export const ScriptedReply = Schema.Struct({
  reasoning: Schema.optionalKey(ScriptedText),
  text: Schema.optionalKey(ScriptedText),
  toolCalls: Schema.optionalKey(Schema.Array(ScriptedToolCall)),
  finishReason: Schema.optionalKey(ScriptedFinishReason),
  usage: Schema.optionalKey(ScriptedUsage),
  chunkSize: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  repeat: Schema.optionalKey(Schema.Boolean),
})
export type ScriptedReply = typeof ScriptedReply.Type

/**
 * The characters per fragment a scripted string is split into when its step names no `chunkSize`.
 *
 * @public
 */
export const SCRIPTED_CHUNK_SIZE = 8

/**
 * A request the scripted endpoint received, as a step's `when` sees it.
 *
 * @public
 */
export interface ScriptedRequest {
  /** Its position among the requests received, from 0. */
  readonly index: number
  readonly url: string
  /** Its headers, names in lower case. */
  readonly headers: Readonly<Record<string, string>>
  /** Its JSON body; `{}` for a body that is not a JSON object, which no step answers. */
  readonly body: Schema.JsonObject
  /** Whether it asked for a streamed reply (`stream: true`). */
  readonly stream: boolean
}

/**
 * A request the scripted endpoint received, with the step that answered it: none when no step matched.
 *
 * @public
 */
export interface ScriptedRequestRecord extends ScriptedRequest {
  readonly step: Option.Option<number>
}

/**
 * A step of a script: a reply, and optionally which request it answers and
 * how its stream is paced. A request takes the first step, in script order,
 * that is still available (not yet used, or `repeat`) and whose `when`
 * accepts it; a step without `when` accepts any. `beforeChunk` runs before
 * each `data:` chunk of a streamed reply is sent (its argument is the
 * chunk's position, from 0), so a test can hold the rest of a reply or
 * slow it down.
 *
 * @public
 */
export type ScriptedStep = ScriptedReply & {
  readonly when?: (request: ScriptedRequest) => boolean
  readonly beforeChunk?: (chunk: number) => Effect.Effect<void>
}
