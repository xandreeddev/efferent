import { Schema } from "effect"
import { Media } from "./media.entity.js"
import { TokenUsage } from "./token-usage.entity.js"

/**
 * The persisted conversation vocabulary — a stable, provider-agnostic shape
 * the loop appends to and the store persists verbatim. `providerOptions` is
 * a JSON blob that round-trips provider-private fields (an Anthropic thinking
 * signature, OpenAI's reasoning item id) without the engine inspecting them.
 */

export const ConversationId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ConversationId"))
export type ConversationId = typeof ConversationId.Type

/** A tool call's pairing key — the provider's id, or the loop's deterministic
 *  `<turnIndex>:<toolName>:<ordinal>` mint when the provider omits one. */
export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

/**
 * A provider's private fields, by provider: effect/ai's response part
 * `metadata`, replayed as its prompt part `options`. The `engine` key is
 * core's own (the turn's usage stamp), never sent to a provider.
 *
 * @public
 */
export const ProviderOptions = Schema.Record(Schema.String, Schema.Json)
export type ProviderOptions = typeof ProviderOptions.Type

/** @public */
export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  providerOptions: Schema.optionalKey(ProviderOptions),
})
export type TextPart = typeof TextPart.Type

/** @public */
export const ReasoningPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  providerOptions: Schema.optionalKey(ProviderOptions),
})
export type ReasoningPart = typeof ReasoningPart.Type

/** @public */
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  input: Schema.Unknown,
  providerOptions: Schema.optionalKey(ProviderOptions),
  providerExecuted: Schema.optional(Schema.Boolean),
})
export type ToolCallPart = typeof ToolCallPart.Type

/** @public */
export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  providerOptions: Schema.optionalKey(ProviderOptions),
  isError: Schema.optional(Schema.Boolean),
  /** Run by the provider (a provider-defined tool): the result is the assistant message's, after its call. */
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  /**
   * Images sent with the result, after `output`'s text: memory's render of
   * the images a result's slots name (`LogBody.ToolResult.media`). Only a
   * rendered message has them; the loop's own tail keeps a result's images
   * inside `output`, as the tool encoded them.
   */
  media: Schema.optionalKey(Schema.Array(Media)),
})
export type ToolResultPart = typeof ToolResultPart.Type

/**
 * One part of a multi-part user message: text, or an image sent inline.
 *
 * @public
 */
export const UserContentPart = Schema.Union([TextPart, Media])
export type UserContentPart = typeof UserContentPart.Type

/**
 * A model-visible message in the user role (the user's own words, turn
 * context, host notes): text, or parts when it carries images (a user's
 * attachments). Narrow with `typeof content === "string"` before reading it
 * as text.
 *
 * @public
 */
export const UserRoleMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(UserContentPart)]),
  providerOptions: Schema.optionalKey(ProviderOptions),
})
export type UserRoleMessage = typeof UserRoleMessage.Type

/**
 * What a model said in one step, in arrival order: a result of a tool the
 * provider ran is among its parts.
 *
 * @public
 */
export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union([TextPart, ReasoningPart, ToolCallPart, ToolResultPart])),
  providerOptions: Schema.optionalKey(ProviderOptions),
})
export type AssistantMessage = typeof AssistantMessage.Type

/** @public */
export const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  content: Schema.Array(ToolResultPart),
  providerOptions: Schema.optionalKey(ProviderOptions),
})
export type ToolMessage = typeof ToolMessage.Type

/** The single conversation unit — persisted as-is, one row per entry. */
export const AgentMessage = Schema.Union([UserRoleMessage, AssistantMessage, ToolMessage])
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
  outcome: Schema.Literals(["ok", "partial"]),
  reason: Schema.Literals(["completed", "step-cap", "degenerate-loop"]),
  /** The run's provider calls summed (its assistant messages' usage). */
  usage: TokenUsage,
})
export type AgentResult = typeof AgentResult.Type
