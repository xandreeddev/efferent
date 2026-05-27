import { Context, type Effect } from "effect"
import type { AgentTool } from "../entities/AgentTool.js"
import type { AgentMessage } from "../entities/Conversation.js"
import type { LlmCacheHint } from "./Llm.js"

export interface LlmSnapshotInput<R> {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
}

/**
 * Provider-side context cache, one snapshot per conversation.
 *
 * The application calls `snapshot` at the end of each `runAgent` with the
 * full message buffer; the adapter creates a provider-side cache resource
 * and returns an opaque hint. Persisted per `(conversation, configKey)`
 * and threaded back into the next turn's `LlmRunTurnInput.cacheHint`.
 *
 * Best-effort: returns `undefined` when the provider declines (content
 * below the model's minimum cacheable size, network blip, etc.) — caching
 * is a cost optimisation, never a correctness requirement.
 *
 * Providers without a native context cache supply a no-op layer that
 * always returns `undefined`.
 */
export class LlmCache extends Context.Tag("@agent/core/LlmCache")<
  LlmCache,
  {
    readonly snapshot: <R>(
      input: LlmSnapshotInput<R>,
    ) => Effect.Effect<LlmCacheHint | undefined, never, R>
  }
>() {}
