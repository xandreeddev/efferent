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
 * A message of a conversation, as a stored event bears it and a request sends it.
 *
 * @public
 */
export const Message = Schema.Union([UserMessage, AssistantMessage])
export type Message = typeof Message.Type
