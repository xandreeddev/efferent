import { Context, Option } from "effect"
import type { Effect } from "effect"
import type { EntryId } from "../memory/memory-log.entity.js"
import type { InvocationId } from "../domain/run.entity.js"
import type { ToolResultInterception } from "../domain/tool-interceptor.entity.js"
import type { ToolResultReceiptPhase, ToolResultReceiptTarget } from "../domain/tool-result-receipt.entity.js"
import type { TurnError } from "../session/sessions.entity.js"

/** Guard-only observation; no transferable claim or recording token. */
export interface ToolResultReceiptGuard {
  readonly target: ToolResultReceiptTarget
  readonly status: Effect.Effect<ToolResultReceiptPhase["_tag"]>
}
export interface ToolResultReceiptOwner {
  readonly guard: ToolResultReceiptGuard
  readonly claim: (invocationId: InvocationId) => Effect.Effect<void, TurnError>
  readonly ready: (metadata: Option.Option<ToolResultInterception>) => Effect.Effect<void, TurnError>
}
export interface ToolResultReceiptOffer {
  readonly guard: ToolResultReceiptGuard
  readonly enter: (target: ToolResultReceiptTarget) => Effect.Effect<Option.Option<ToolResultReceiptOwner>>
}
export interface ToolResultReceiptReservation {
  readonly metadata: Option.Option<ToolResultInterception>
  readonly recorded: (entry: EntryId) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}
export interface ToolResultReceiptRecording {
  readonly guard: ToolResultReceiptGuard
  readonly reserve: (target: ToolResultReceiptTarget) => Effect.Effect<ToolResultReceiptReservation, TurnError>
}
export interface ToolResultReceipt {
  readonly guard: ToolResultReceiptGuard
  readonly offer: ToolResultReceiptOffer
  readonly recording: ToolResultReceiptRecording
  readonly close: Effect.Effect<void>
}
export type ToolResultReceiptContext =
  | { readonly _tag: "Offer"; readonly offer: ToolResultReceiptOffer }
  | { readonly _tag: "Guard"; readonly guard: ToolResultReceiptGuard }
  | { readonly _tag: "Record"; readonly recording: ToolResultReceiptRecording }

/** Dynamic offer/record scope is replaced by its guard before arbitrary code. */
export const CurrentToolResultReceipt = Context.Reference<Option.Option<ToolResultReceiptContext>>("@xandreed/core/CurrentToolResultReceipt", { defaultValue: () => Option.none() })
