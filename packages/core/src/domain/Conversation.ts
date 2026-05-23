import { Schema } from "effect"

export const ConversationId = Schema.UUID.pipe(Schema.brand("ConversationId"))
export type ConversationId = typeof ConversationId.Type

export const ToolCall = Schema.Struct({
  toolName: Schema.String,
  args: Schema.Unknown,
})
export type ToolCall = typeof ToolCall.Type

export const ToolResult = Schema.Struct({
  toolName: Schema.String,
  result: Schema.Unknown,
})
export type ToolResult = typeof ToolResult.Type

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.String,
})

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.String,
  toolCalls: Schema.Array(ToolCall),
})

export const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  toolName: Schema.String,
  result: Schema.Unknown,
})

export const ConversationMessage = Schema.Union(
  UserMessage,
  AssistantMessage,
  ToolMessage,
)
export type ConversationMessage = typeof ConversationMessage.Type

export const AgentResult = Schema.Struct({
  finalText: Schema.String,
  toolCalls: Schema.Array(ToolCall),
  toolResults: Schema.Array(ToolResult),
})
export type AgentResult = typeof AgentResult.Type
