import { Schema } from "effect"

export const ConversationId = Schema.UUID.pipe(Schema.brand("ConversationId"))
export type ConversationId = typeof ConversationId.Type

export const Checkpoint = Schema.Struct({
  id: Schema.UUID,
  conversationId: ConversationId,
  messagePosition: Schema.Number,
  summary: Schema.String,
  createdAt: Schema.Number,
})
export type Checkpoint = typeof Checkpoint.Type

/**
 * Content-part schemas, structurally mirroring Vercel AI SDK v6
 * `ModelMessage` parts so the adapter boundary is a near-identity cast.
 * `providerOptions` is opaque — it round-trips provider-private fields
 * (e.g. Gemini's `thought_signature` on a reasoning part) without us
 * inspecting them.
 */
export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown),
})

export const ReasoningPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown),
})

export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
  providerOptions: Schema.optional(Schema.Unknown),
  providerExecuted: Schema.optional(Schema.Boolean),
})

export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  output: Schema.Unknown,
  providerOptions: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
})

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.String,
  providerOptions: Schema.optional(Schema.Unknown),
})

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(
    Schema.Union(TextPart, ReasoningPart, ToolCallPart),
  ),
  providerOptions: Schema.optional(Schema.Unknown),
})

export const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  content: Schema.Array(ToolResultPart),
  providerOptions: Schema.optional(Schema.Unknown),
})

/**
 * The single conversation unit. Persisted as-is (one row per entry,
 * full JSON in the `content` column). Loaded fresh at the start of
 * every `runAgent` call; the loop appends to it and the application
 * persists the new tail at the end.
 */
export const AgentMessage = Schema.Union(
  UserMessage,
  AssistantMessage,
  ToolMessage,
)
export type AgentMessage = typeof AgentMessage.Type

/**
 * Lightweight transient summary types used in hook events and the
 * agent's result payload. These are NOT what gets persisted — full
 * messages above are. Adapters extract these from the message content
 * parts when firing hooks.
 */
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

/**
 * Result of one `runAgent` invocation. `finalText` is extracted from
 * the last assistant message's text parts; `messages` is the FULL
 * conversation state at the end of the run (loaded history + new tail);
 * `newTail` is exactly what the loop APPENDED — including synthetic
 * messages it injected itself (malformed-response correctives). Persist
 * `newTail`; never reconstruct it by index arithmetic on `messages`,
 * which silently breaks the moment a context transform reshapes the
 * buffer mid-run (auto-compaction).
 */
export const AgentResult = Schema.Struct({
  finalText: Schema.String,
  messages: Schema.Array(AgentMessage),
  newTail: Schema.Array(AgentMessage),
  /** The loop hit `maxSteps` while the model still wanted more tool calls —
   *  `finalText` is mid-thought narration, NOT a deliverable. Callers
   *  surfacing the result should mark it partial. */
  stoppedAtMaxSteps: Schema.optional(Schema.Boolean),
})
export type AgentResult = typeof AgentResult.Type
