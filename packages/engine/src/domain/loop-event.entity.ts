import type { TokenUsage } from "./token-usage.entity.js"
import type { AgentFailure } from "./agent-failure.entity.js"

/**
 * The loop's event vocabulary — everything a driver needs to render a run
 * live. ONE union, ONE optional sink (`onEvent`), instead of a record of
 * optional callbacks: the session chassis pumps these onto its ledger and a
 * product extends the vocabulary with its own `{ type: ... }` events.
 *
 * Discriminated on `type` (not `_tag`) so product events compose naturally
 * (`type SessionEvent = LoopEvent | { type: "math_render"; ... }`).
 */

export interface ToolCallSummary {
  readonly id: string
  readonly toolName: string
  readonly args: unknown
}

export type LoopEvent =
  | { readonly type: "turn_start"; readonly turnIndex: number }
  /**
   * One streamed content increment, TRANSIENT by design: it exists only for
   * live rendering, is never ledgered or replayed, and every fact it carries
   * is restated by the turn's `assistant_message` (the sole finalizer —
   * position/usage ride only there). `id` scopes deltas to one content chunk
   * within the turn (a turn can hold several, e.g. reasoning then text).
   */
  | {
      readonly type: "assistant_delta"
      readonly turnIndex: number
      /** `tool-params` deltas carry the tool call's streamed ARGUMENT text —
       *  they exist for incremental admission (a session may act on a
       *  complete argument prefix before the call settles) and are noise to
       *  plain text renderers, which should drop the channel. */
      readonly channel: "text" | "reasoning" | "tool-params"
      readonly id: string
      readonly delta: string
      /** The tool being called — present on `tool-params` deltas only. */
      readonly toolName?: string
    }
  | {
      readonly type: "assistant_message"
      readonly turnIndex: number
      readonly text: string
      readonly reasoning: string
      /** The resolved `provider:modelId` that produced this message. */
      readonly model?: string
      readonly toolCalls: ReadonlyArray<ToolCallSummary>
      readonly usage: TokenUsage
      /** The assistant message's absolute store position, when persisted —
       *  the durable identity a UI keys its rail block on. */
      readonly position?: number
    }
  | {
      readonly type: "tool_start"
      readonly turnIndex: number
      readonly toolCallId: string
      readonly toolName: string
      readonly args: unknown
    }
  | {
      readonly type: "tool_end"
      readonly turnIndex: number
      readonly toolCallId: string
      readonly toolName: string
      readonly args: unknown
      readonly ok: boolean
      readonly result: unknown
    }
  /** The mid-run fold: the buffer outgrew the healthy context range and the
   *  older turns were replaced by a handoff summary — `kept` verbatim
   *  messages survive after it. A load-side rewrite; nothing is deleted. */
  | {
      readonly type: "compaction"
      readonly turnIndex: number
      readonly tokens: number
      readonly kept: number
    }
  | {
      readonly type: "agent_end"
      readonly outcome: "ok" | "partial"
      readonly reason: "completed" | "step-cap" | "degenerate-loop"
      readonly finalText: string
    }
  /** A turn crashed outside the model's control (provider failure after
   *  retries, a defect). Published by the chassis, part of the vocabulary so
   *  every driver renders failures the same way. */
  | {
      readonly type: "error"
      /** Human-readable presentation text. */
      readonly message: string
      /** Machine-readable context retained by stores, hosts, and evals. */
      readonly failure?: AgentFailure
    }
