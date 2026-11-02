import { Schema, Struct } from "effect"
import { InboxItemId, InboxQueuedData, InputDelivery, RunId, SessionAddress, TurnEndReason, TurnOrigin, TurnStartedData, UserMessage } from "@xandreed/core"

export const InboxDrainResume = Schema.Union([
  Schema.TaggedStruct("Never", {}),
  Schema.TaggedStruct("Before", { userMessage: Schema.optionalKey(UserMessage) }),
]).pipe(Schema.toTaggedUnion("_tag"))

/** Host policy for the scoped inbox drainer. Owners are always explicit. @public */
export const InboxDrainConfig = Schema.Struct({
  owners: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  sweepIntervalMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 })),
  pageSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  backoff: Schema.Struct({
    initialMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 })),
    maxMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 })),
  }).check(Schema.makeFilter((value) => value.maxMs >= value.initialMs ? true : "maxMs must be at least initialMs")),
  resume: InboxDrainResume,
  /**
   * Unsuccessful runs (failed or partial) of one queued input, or failed
   * resumes of one interrupted turn, before the drainer parks it: the input
   * stays queued, never dropped, but the drainer stops starting it and runs
   * later input instead. A host runs a parked input with `BeginTurn.Queued`.
   */
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  takeOver: Schema.Boolean,
})
export type InboxDrainConfig = typeof InboxDrainConfig.Type
/** Required owner scope and optional policy overrides. @public */
export type InboxDrainOptions = Pick<InboxDrainConfig, "owners"> & Partial<Omit<InboxDrainConfig, "owners">>
/** Defaults never invent an owner or permission to take over another holder. @public */
export const inboxDrainDefaults: Omit<InboxDrainConfig, "owners"> = {
  concurrency: 4, sweepIntervalMs: 1000, pageSize: 100,
  backoff: { initialMs: 250, maxMs: 30_000 }, resume: { _tag: "Before" }, attempts: 3, takeOver: false,
}

/** Journal projections reuse existing fields and omit messages, image bytes and private source metadata. */
export const DrainStartedData = TurnStartedData.mapFields(Struct.pick(["runId", "origin", "claimed", "input", "resumes"]))
export const DrainQueuedData = InboxQueuedData.mapFields((fields) => ({
  id: fields.id, input: Schema.optionalKey(Schema.Struct({ delivery: InputDelivery })),
}))
export const DrainEvent = Schema.Union([
  Schema.TaggedStruct("Enqueued", { id: InboxItemId, delivery: Schema.OptionFromNullOr(InputDelivery) }),
  Schema.TaggedStruct("Started", { turn: Schema.Int, runId: RunId, origin: TurnOrigin, claimed: Schema.Array(InboxItemId), input: Schema.OptionFromNullOr(InboxItemId), resumes: Schema.OptionFromNullOr(Schema.Int) }),
  /** `code`, the stored failure's (`turn.lease`, `turn.time-limit`…); `seq`, where the end was stored. */
  Schema.TaggedStruct("Ended", { turn: Schema.Int, reason: TurnEndReason, code: Schema.OptionFromNullOr(Schema.String), seq: Schema.Int }),
  Schema.TaggedStruct("Removed", { id: InboxItemId }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type DrainEvent = typeof DrainEvent.Type
export const DrainHistory = Schema.Struct({
  slots: Schema.Array(Schema.Struct({ id: InboxItemId, delivery: Schema.OptionFromNullOr(InputDelivery), claimedBy: Schema.OptionFromNullOr(Schema.Int) })),
  turns: Schema.Array(Schema.Struct({
    turn: Schema.Int, runId: RunId, origin: TurnOrigin, resumes: Schema.OptionFromNullOr(Schema.Int), input: Schema.OptionFromNullOr(InboxItemId),
    ended: Schema.OptionFromNullOr(TurnEndReason), code: Schema.OptionFromNullOr(Schema.String), endedAt: Schema.OptionFromNullOr(Schema.Int),
  })),
})
export type DrainHistory = typeof DrainHistory.Type

/**
 * What decides a session's next drain target besides its journal: the
 * host's resume policy and attempt limit, and `baseline`, the session's
 * last sequence number the startup sweep saw (a turn interrupted at or
 * before it was stopped with an earlier process).
 */
export const DrainPolicy = Schema.Struct({ resume: InboxDrainResume, attempts: Schema.Int, baseline: Schema.OptionFromNullOr(Schema.Int) })
export type DrainPolicy = typeof DrainPolicy.Type

/** The open turn a startup sweep saw and may take over: exactly that turn, never one begun since. */
export const DrainTakeover = Schema.Struct({ turn: Schema.Int, runId: RunId })
export type DrainTakeover = typeof DrainTakeover.Type

export const DrainTarget = Schema.Union([
  Schema.TaggedStruct("Resume", { turn: Schema.Int, after: Schema.Int }),
  Schema.TaggedStruct("Queued", { input: InboxItemId }),
  Schema.TaggedStruct("Inbox", { first: InboxItemId }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type DrainTarget = typeof DrainTarget.Type
const jobFields = {
  address: SessionAddress, target: DrainTarget, failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Startup takeover authority, consumed by the job's first claim. */
  takeOver: Schema.OptionFromNullOr(DrainTakeover),
}
export const DrainJob = Schema.Union([
  Schema.TaggedStruct("Ready", jobFields),
  Schema.TaggedStruct("Running", jobFields),
  Schema.TaggedStruct("Delayed", { ...jobFields, due: Schema.Finite }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type DrainJob = typeof DrainJob.Type
export const DrainScheduler = Schema.Struct({ jobs: Schema.Record(Schema.String, DrainJob), nextOrder: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
export type DrainScheduler = typeof DrainScheduler.Type
export const DrainAttempt = Schema.Union([
  Schema.TaggedStruct("Done", {}),
  Schema.TaggedStruct("Retry", { target: DrainTarget }),
  Schema.TaggedStruct("Stopped", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type DrainAttempt = typeof DrainAttempt.Type
