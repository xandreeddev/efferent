import { Schema } from "effect"

/**
 * The persisted conversation vocabulary — a stable, provider-agnostic shape
 * the loop appends to and the store persists verbatim. `providerOptions` is
 * an opaque blob that round-trips provider-private fields (e.g. Gemini's
 * `thought_signature` on a reasoning part) without the engine inspecting them.
 */

export const ConversationId = Schema.UUID.pipe(Schema.brand("ConversationId"))
export type ConversationId = typeof ConversationId.Type

/** A tool call's pairing key — the provider's id, or the loop's deterministic
 *  `<turnIndex>:<toolName>:<ordinal>` mint when the provider omits one. */
export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

export class Checkpoint extends Schema.Class<Checkpoint>("Checkpoint")({
  conversationId: ConversationId,
  /** The absolute message position this fold covers (inclusive). */
  messagePosition: Schema.Number,
  summary: Schema.String,
  createdAt: Schema.Number,
}) {}

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown),
})
export type TextPart = typeof TextPart.Type

export const ReasoningPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown),
})
export type ReasoningPart = typeof ReasoningPart.Type

export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  input: Schema.Unknown,
  providerOptions: Schema.optional(Schema.Unknown),
  providerExecuted: Schema.optional(Schema.Boolean),
})
export type ToolCallPart = typeof ToolCallPart.Type

export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  providerOptions: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
})
export type ToolResultPart = typeof ToolResultPart.Type

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown),
})
export type UserMessage = typeof UserMessage.Type

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union(TextPart, ReasoningPart, ToolCallPart)),
  providerOptions: Schema.optional(Schema.Unknown),
})
export type AssistantMessage = typeof AssistantMessage.Type

export const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  content: Schema.Array(ToolResultPart),
  providerOptions: Schema.optional(Schema.Unknown),
})
export type ToolMessage = typeof ToolMessage.Type

/** The single conversation unit — persisted as-is, one row per entry. */
export const AgentMessage = Schema.Union(UserMessage, AssistantMessage, ToolMessage)
export type AgentMessage = typeof AgentMessage.Type

/**
 * Result of one agent run. `newTail` is exactly what the loop APPENDED —
 * including synthetic correctives it injected itself. Persist `newTail`;
 * never reconstruct it by index arithmetic on `messages`.
 */
export const AgentResult = Schema.Struct({
  finalText: Schema.String,
  messages: Schema.Array(AgentMessage),
  newTail: Schema.Array(AgentMessage),
  /** "ok" — the model finished on its own; "partial" — the step cap or the
   *  degenerate-loop breaker stopped it, so `finalText` is NOT a deliverable. */
  outcome: Schema.Literal("ok", "partial"),
  reason: Schema.Literal("completed", "step-cap", "degenerate-loop"),
})
export type AgentResult = typeof AgentResult.Type
