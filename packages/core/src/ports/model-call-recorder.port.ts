import { Context, Effect } from "effect"
import type { ModelCallData, ModelCallLegacyUsage } from "../domain/model-call.entity.js"
import type { TurnError } from "../session/sessions.entity.js"

/** Turn-owned billing observation; callbacks never fail recording. @public */
export interface ModelCallObserver {
  /** Bootstrap and future durable calls, once per key for this observer. */
  readonly called: (data: ModelCallData, info: { readonly replayed: boolean }) => Effect.Effect<void>
  /** Once at owner close, after helper/finalizer work; use legacy only with no calls. */
  readonly closed: (legacy: ReadonlyArray<ModelCallLegacyUsage>) => Effect.Effect<void>
}

/** Durable terminal facts: record flushes before returning; failures retain TurnError. @public */
export interface ModelCallRecorder {
  readonly record: (data: ModelCallData) => Effect.Effect<void, TurnError>
  /** Optional owner-lifetime observation, with atomic bootstrap replay and live registration. */
  readonly observe?: (listener: ModelCallObserver) => Effect.Effect<void>
}

/** Read at call execution. Outside a turn, recording deliberately does nothing. @public */
export const CurrentModelCallRecorder = Context.Reference<ModelCallRecorder>("@xandreed/core/CurrentModelCallRecorder", {
  defaultValue: () => ({ record: () => Effect.void }),
})

/** Private notification ancestry: a terminal ACK cannot await its own callback. */
export const CurrentModelCallNotifications = Context.Reference<ReadonlySet<object>>("@xandreed/core/CurrentModelCallNotifications", {
  defaultValue: () => new Set(),
})
