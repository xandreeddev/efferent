import { Schema } from "effect"
import { HarnessError, JsonObject, ReservedKind, SessionContended, SessionLogError, TurnClosed, TurnEnding } from "@xandreed/core"

/*
 * The open turn's writer as one phase: what it admits, whether its end is
 * under way or stored, and what it refuses once it stopped. The adapter
 * keeps the phase in one `Ref` and moves it only by the transitions of
 * `turn-writer.entity.functions.ts` (`Ref.modify` with a pure decision),
 * running what a transition planned after it.
 */

/** Why the writer takes no more writes, as its `TurnClosed` says. */
export const TurnClosedReason = TurnClosed.fields.reason
export type TurnClosedReason = typeof TurnClosedReason.Type

/** Why someone else closed the turn: what `TurnWriter.closed` gives (never `ended`). */
export const ClosedBy = TurnClosedReason.pick(["cancelled", "interrupted", "removed"])
export type ClosedBy = typeof ClosedBy.Type

/** What a writer that failed refuses every later write with: the store's failure, contention, or its own state's (a `TurnError` but `TurnClosed`). */
export const WriterFailure = Schema.Union([HarnessError, ReservedKind, SessionContended, SessionLogError])
export type WriterFailure = typeof WriterFailure.Type

/** The drafts a turn holds for its closing commit (`TurnWriter.closing`), stored right before its `turn.ended`. */
export const ClosingDrafts = Schema.Array(Schema.Struct({ kind: Schema.String, data: JsonObject }))
export type ClosingDrafts = typeof ClosingDrafts.Type

/**
 * - `Open`: admits writes; `tried` once the turn wrote anything (only then has
 *   it tried the inbox items it took), `attempted` the last ending whose commit
 *   ran and was not stored (the scope's own end tries it again), `closing`
 *   the drafts held for the end's commit.
 * - `Ending`: an end is under way, and admission is sealed; `attempted` is the
 *   one before it, kept for when this end is never queued; `closing` what its
 *   commit stores before `turn.ended`.
 * - `Failed`: a write failed (the store, contention, a defect): every later one
 *   fails with that `error`, and the closing drafts are dropped.
 * - `Closed`: closed elsewhere (`cancelled`, `interrupted`, `removed`), or its
 *   scope closed (`ended`): every later write fails with that `TurnClosed`, and
 *   the closing drafts are dropped.
 * - `Ended`: its end is stored, and left `pending` inbox items waiting.
 */
export const WriterPhase = Schema.Union([
  Schema.TaggedStruct("Open", { tried: Schema.Boolean, attempted: Schema.OptionFromNullOr(TurnEnding), closing: ClosingDrafts }),
  Schema.TaggedStruct("Ending", { tried: Schema.Boolean, ending: TurnEnding, attempted: Schema.OptionFromNullOr(TurnEnding), closing: ClosingDrafts }),
  Schema.TaggedStruct("Failed", { error: WriterFailure }),
  Schema.TaggedStruct("Closed", { reason: TurnClosedReason }),
  Schema.TaggedStruct("Ended", { pending: Schema.Int }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type WriterPhase = typeof WriterPhase.Type

/** A phase that refuses every write: what a refused transition fails with (the adapter raises it as its `TurnError`). */
export type WriterStopped = Extract<WriterPhase, { readonly _tag: "Failed" | "Closed" }>

/** What an end does: `Start` a commit of its own (the writer moves to `phase`), `Share` the end under way, or answer the one `Stored`. */
export const EndStep = Schema.Union([
  Schema.TaggedStruct("Start", { phase: WriterPhase }),
  Schema.TaggedStruct("Share", {}),
  Schema.TaggedStruct("Stored", { pending: Schema.Int }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type EndStep = typeof EndStep.Type
