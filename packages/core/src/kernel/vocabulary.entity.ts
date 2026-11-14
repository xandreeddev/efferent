import { Schema } from "effect"
import type { LiveDefinition, StoredDefinition } from "./event.entity.js"
import { coreLiveEvent, coreStoredEvent } from "./event.entity.functions.js"
import { EventName, TurnNumber } from "./ids.entity.js"
import type { Vocabulary } from "./journal.entity.js"

/*
 * Core's own events: those of the session contract, which every agent has
 * whatever its workflow, and `core.listener.failed`. They are named
 * `core.`, after the owner of the contract that defines them. A plugin's
 * events are defined in its own folder with `storedEvent` and `liveEvent`.
 */

/**
 * The data of `core.session.turn.started`: the turn that opened.
 *
 * @public
 */
export const TurnStartedData = Schema.Struct({ turn: TurnNumber })
export type TurnStartedData = typeof TurnStartedData.Type

/** `core.session.turn.started`: a turn opened on the session. Stored. */
export const turnStartedEvent: StoredDefinition<TurnStartedData> = coreStoredEvent("core.session.turn.started", { data: TurnStartedData, skippable: false, tags: ["turn"] })

/**
 * How a turn ended: completed, failed with the reason, or interrupted. The reply is not here: a turn's workflow records it.
 *
 * @public
 */
export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct("Completed", {}),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  Schema.TaggedStruct("Interrupted", {}),
])
export type TurnOutcome = typeof TurnOutcome.Type

/**
 * The data of `core.session.turn.ended`: the turn that closed, and how.
 *
 * @public
 */
export const TurnEndedData = Schema.Struct({ turn: TurnNumber, outcome: TurnOutcome })
export type TurnEndedData = typeof TurnEndedData.Type

/** `core.session.turn.ended`: the turn closed, with its outcome. Stored. */
export const turnEndedEvent: StoredDefinition<TurnEndedData> = coreStoredEvent("core.session.turn.ended", { data: TurnEndedData, skippable: false, tags: ["turn"] })

/**
 * The data of `core.listener.failed`: which listener, on which event, and why.
 *
 * @public
 */
export const ListenerFailedData = Schema.Struct({ listener: Schema.String, event: EventName, reason: Schema.String })
export type ListenerFailedData = typeof ListenerFailedData.Type

/** `core.listener.failed`: a listener failed where nothing could fail for it. Live only. */
export const listenerFailedEvent: LiveDefinition<ListenerFailedData> = coreLiveEvent("core.listener.failed", { data: ListenerFailedData, tags: ["trace"] })

/**
 * What every vocabulary answers for: core's own records, those
 * under `core.`. A plugin's vocabulary adds its own prefix (`vocabularyOf`), over
 * this one or over another plugin's vocabulary it extends.
 *
 * @public
 */
export const KERNEL_VOCABULARY: Vocabulary = {
  reads: ["core."],
  knows: [turnStartedEvent.name, turnEndedEvent.name],
}
