import type { TokenUsage } from "./TokenUsage.js"

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
  | { readonly type: "error"; readonly message: string }
