import { Schema } from "effect"
import { ToolCallId } from "./ids.entity.js"

/**
 * What a user sent: text only.
 *
 * @public
 */
export const UserMessage = Schema.TaggedStruct("User", { text: Schema.String })
export type UserMessage = typeof UserMessage.Type

/**
 * One call the model asked for.
 *
 * @public
 */
export const ToolCall = Schema.Struct({ id: ToolCallId, name: Schema.String, input: Schema.Json })
export type ToolCall = typeof ToolCall.Type

/**
 * What the model answered in one step: its text and the tools it asked for.
 *
 * @public
 */
export const AssistantMessage = Schema.TaggedStruct("Assistant", { text: Schema.String, toolCalls: Schema.Array(ToolCall) })
export type AssistantMessage = typeof AssistantMessage.Type

/**
 * What one tool call came to: its result as the tool encoded it, or, with `isFailure`, why it failed. A failure is
 * an answer like any other: the model reads it and decides what to do next. The call it answers is `id`.
 *
 * @public
 */
export const ToolResult = Schema.TaggedStruct("ToolResult", { id: ToolCallId, name: Schema.String, result: Schema.Json, isFailure: Schema.Boolean })
export type ToolResult = typeof ToolResult.Type

/**
 * A message of a conversation, as a stored event bears it and a request sends it.
 *
 * @public
 */
export const Message = Schema.Union([UserMessage, AssistantMessage, ToolResult])
export type Message = typeof Message.Type
