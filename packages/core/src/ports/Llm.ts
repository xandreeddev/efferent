import { Context, Data, type Effect, type Stream } from "effect"
import type { AgentHooks } from "../domain/AgentHooks.js"
import type { AgentTool } from "../domain/AgentTool.js"
import type { AgentMessage, ToolCall } from "../domain/Conversation.js"

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
 * One model turn. The adapter:
 *   - Sends `[system, ...messages]` to the model (system prompt computed
 *     per call by the application; never persisted).
 *   - Executes any tool calls the model emits, observing the
 *     `onBeforeToolCall` / `onAfterToolCall` hooks.
 *   - Returns the new messages produced this turn (assistant message(s)
 *     plus any tool result messages), to be appended to the running
 *     conversation buffer by the loop.
 */
/**
 * Opaque handle to a provider-side cache containing the
 * `(system + tools + a prefix of messages)` for a conversation. The
 * application persists it per conversation and threads it back via
 * `cacheHint` on subsequent calls. Created by `Llm.snapshot`.
 */
export type LlmCacheHint = unknown

export interface LlmRunTurnInput<R> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
  readonly turnIndex: number
  readonly hooks?: AgentHooks<R>
  /** Opaque hint from a prior `Llm.snapshot`. When present and valid,
   * the adapter sends only the new messages beyond what's cached. */
  readonly cacheHint?: LlmCacheHint
}

export interface LlmRunTurnResult {
  readonly newMessages: ReadonlyArray<AgentMessage>
  readonly finishReason: string
  /** Joined text from the assistant message(s) produced this turn. */
  readonly assistantText: string
  /** Tool-call summaries the assistant emitted this turn. */
  readonly toolCalls: ReadonlyArray<ToolCall>
}

export interface LlmSnapshotInput<R> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
}

export class Llm extends Context.Tag("@agent/core/Llm")<
  Llm,
  {
    readonly generate: (
      input: LlmGenerateInput,
    ) => Effect.Effect<string, LlmError>
    readonly streamGenerate: (
      input: LlmGenerateInput,
    ) => Stream.Stream<string, LlmError>
    readonly runTurn: <R>(
      input: LlmRunTurnInput<R>,
    ) => Effect.Effect<LlmRunTurnResult, LlmError, R>
    /**
     * Snapshot the conversation prefix into a provider-side cache.
     * Returns an opaque hint the application persists per conversation
     * and passes back on subsequent `runTurn` calls via `cacheHint`.
     * Best-effort: returns undefined on failure (e.g. content below
     * the provider's minimum cacheable size); the caller continues
     * uncached.
     */
    readonly snapshot: <R>(
      input: LlmSnapshotInput<R>,
    ) => Effect.Effect<LlmCacheHint | undefined, never, R>
  }
>() {}
