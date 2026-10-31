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
  takeOver: Schema.Boolean,
})
export type InboxDrainConfig = typeof InboxDrainConfig.Type
/** Required owner scope and optional policy overrides. @public */
export type InboxDrainOptions = Pick<InboxDrainConfig, "owners"> & Partial<Omit<InboxDrainConfig, "owners">>
/** Defaults never invent an owner or permission to take over another holder. @public */
export const inboxDrainDefaults: Omit<InboxDrainConfig, "owners"> = {
  concurrency: 4, sweepIntervalMs: 1000, pageSize: 100,
  backoff: { initialMs: 250, maxMs: 30_000 }, resume: { _tag: "Before" }, takeOver: false,
}

/** Journal projections reuse existing fields and omit messages, image bytes and private source metadata. */
export const DrainStartedData = TurnStartedData.mapFields(Struct.pick(["runId", "origin", "claimed", "input", "resumes"]))
export const DrainQueuedData = InboxQueuedData.mapFields((fields) => ({
  id: fields.id, input: Schema.optionalKey(Schema.Struct({ delivery: InputDelivery })),
}))
export const DrainEvent = Schema.Union([
  Schema.TaggedStruct("Enqueued", { id: InboxItemId, delivery: Schema.OptionFromNullOr(InputDelivery) }),
  Schema.TaggedStruct("Started", { turn: Schema.Int, runId: RunId, origin: TurnOrigin, claimed: Schema.Array(InboxItemId), input: Schema.OptionFromNullOr(InboxItemId), resumes: Schema.OptionFromNullOr(Schema.Int) }),
  Schema.TaggedStruct("Ended", { turn: Schema.Int, reason: TurnEndReason }),
  Schema.TaggedStruct("Removed", { id: InboxItemId }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type DrainEvent = typeof DrainEvent.Type
export const DrainHistory = Schema.Struct({
  slots: Schema.Array(Schema.Struct({ id: InboxItemId, delivery: Schema.OptionFromNullOr(InputDelivery), claimedBy: Schema.OptionFromNullOr(Schema.Int) })),
  turns: Schema.Array(Schema.Struct({ turn: Schema.Int, runId: RunId, origin: TurnOrigin, resumes: Schema.OptionFromNullOr(Schema.Int), ended: Schema.OptionFromNullOr(TurnEndReason) })),
})
export type DrainHistory = typeof DrainHistory.Type

export const DrainTarget = Schema.Union([
  Schema.TaggedStruct("Resume", { turn: Schema.Int, after: Schema.Int }),
  Schema.TaggedStruct("Queued", { input: InboxItemId }),
  Schema.TaggedStruct("Inbox", { first: InboxItemId }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type DrainTarget = typeof DrainTarget.Type
const jobFields = {
  address: SessionAddress, target: DrainTarget, failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), startup: Schema.Boolean,
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
