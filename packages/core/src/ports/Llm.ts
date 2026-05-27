import { Context, Data, type Effect } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentTool } from "../entities/AgentTool.js"
import type { AgentMessage, ToolCall } from "../entities/Conversation.js"

export class LlmError extends Data.TaggedError("LlmError")<{
  readonly cause: unknown
  readonly message: string
}> {}

export interface LlmImage {
  readonly bytes: Uint8Array
  readonly mimeType: string
}

export interface LlmGenerateInput {
  readonly prompt: string
  readonly images?: ReadonlyArray<LlmImage>
  readonly system?: string
}

/**
 * Opaque handle to a provider-side cache containing the
 * `(system + tools + a prefix of messages)` for a conversation. The
 * application persists it per conversation and threads it back via
 * `cacheHint` on subsequent calls. Created by `LlmCache.snapshot`.
 */
export type LlmCacheHint = unknown

export interface LlmRunTurnInput<R> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
  readonly turnIndex: number
  readonly hooks?: AgentHooks<R>
  /** Opaque hint from a prior `LlmCache.snapshot`. When present and valid,
   * the adapter sends only the new messages beyond what's cached. */
  readonly cacheHint?: LlmCacheHint
}

/**
 * Per-turn token usage as reported by the LLM provider. `totalTokens` is
 * the provider's own field where present; otherwise it's
 * `inputTokens + outputTokens`. `cacheReadTokens` is the portion of
 * `inputTokens` that hit the provider-side cache (0 when no cache).
 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
}

export interface LlmRunTurnResult {
  readonly newMessages: ReadonlyArray<AgentMessage>
  readonly finishReason: string
  /** Joined text from the assistant message(s) produced this turn. */
  readonly assistantText: string
  /** Tool-call summaries the assistant emitted this turn. */
  readonly toolCalls: ReadonlyArray<ToolCall>
  /** Token accounting for the turn. */
  readonly usage: TokenUsage
}

/**
 * Agent-loop tier. One method: drive a single model step (assistant
 * message + any tool calls it requests). The loop owns iteration; this
 * port owns one step.
 *
 * For non-loop text-in/text-out work see `LlmFast`. For per-conversation
 * cache snapshots see `LlmCache`. For static model metadata (id, context
 * window) see `LlmInfo`.
 */
export class Llm extends Context.Tag("@agent/core/Llm")<
  Llm,
  {
    readonly runTurn: <R>(
      input: LlmRunTurnInput<R>,
    ) => Effect.Effect<LlmRunTurnResult, LlmError, R>
  }
>() {}
