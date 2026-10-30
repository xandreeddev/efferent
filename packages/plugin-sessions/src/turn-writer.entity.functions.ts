import { Exit, Option, Result } from "effect"
import { replyEndingOf } from "@xandreed/core"
import type { TurnClosed, TurnEnding, TurnError } from "@xandreed/core"
import { WriterPhase } from "./turn-writer.entity.js"
import type { ClosedBy, ClosingDrafts, EndStep, WriterStopped } from "./turn-writer.entity.js"

/*
 * The writer's transitions: pure decisions over its phase. Each returns the
 * next phase (or a refusal, as the stopped phase that refuses); the adapter
 * applies it with `Ref.modify` and then runs what it planned: queue an item,
 * commit an end, settle the callers.
 */

/** The writer's own refusal once its end is under way or stored, or its scope closed: `TurnClosed`, `ended`. */
const sealed: WriterStopped = { _tag: "Closed", reason: "ended" }

/** A writer as its turn begins: open, nothing written, no end attempted, nothing held for its end. */
export const opened: WriterPhase = { _tag: "Open", tried: false, attempted: Option.none(), closing: [] }

const isStopped = WriterPhase.isAnyOf(["Failed", "Closed"])
const isLive = WriterPhase.isAnyOf(["Open", "Ending"])

/** What a phase refuses every write with: a stopped one's failure or `TurnClosed`; none while it is open, ending or ended. */
export const stopped = (phase: WriterPhase): Option.Option<WriterStopped> => isStopped(phase) ? Option.some(phase) : Option.none()

const isClosed = (error: TurnError): error is TurnClosed => error._tag === "TurnClosed"

/** The stop a failure means: a `TurnClosed` closes the writer with its reason, anything else fails it. */
const stopOf = (error: TurnError): WriterStopped => isClosed(error) ? { _tag: "Closed", reason: error.reason } : { _tag: "Failed", error }

/**
 * A write asks to be queued. An open writer admits it, as having tried the
 * inbox items the turn took when it `tries` (it writes something); an ending
 * or ended one refuses it as `ended`; a stopped one with its own refusal.
 */
export const admit = (phase: WriterPhase, tries: boolean): Result.Result<WriterPhase, WriterStopped> => WriterPhase.match(phase, {
  Open: (open) => Result.succeed(tries ? { ...open, tried: true } : open),
  Ending: () => Result.fail(sealed),
  Failed: (failed) => Result.fail(failed),
  Closed: (closed) => Result.fail(closed),
  Ended: () => Result.fail(sealed),
})

/**
 * The turn holds its closing drafts (`TurnWriter.closing`), replacing what it
 * held: only while the writer is open, as having tried the inbox items it
 * took when it holds any (the end stores them). An ending or ended writer
 * refuses them as `ended`, a stopped one with its own refusal.
 */
export const hold = (phase: WriterPhase, closing: ClosingDrafts): Result.Result<WriterPhase, WriterStopped> => WriterPhase.match(phase, {
  Open: (open) => Result.succeed({ ...open, tried: open.tried || closing.length > 0, closing }),
  Ending: () => Result.fail(sealed),
  Failed: (failed) => Result.fail(failed),
  Closed: (closed) => Result.fail(closed),
  Ended: () => Result.fail(sealed),
})

/**
 * An end asks to begin. An open writer starts one with `ending`, sealing
 * admission until it settles, its commit to store the drafts held; an end
 * under way is shared; a stored one answers with what it left pending; a
 * stopped writer refuses it.
 */
export const beginEnd = (phase: WriterPhase, ending: TurnEnding): Result.Result<EndStep, WriterStopped> => WriterPhase.match(phase, {
  Open: (open) => Result.succeed<EndStep>({ _tag: "Start", phase: { _tag: "Ending", tried: open.tried, ending, attempted: open.attempted, closing: open.closing } }),
  Ending: () => Result.succeed<EndStep>({ _tag: "Share" }),
  Failed: (failed) => Result.fail(failed),
  Closed: (closed) => Result.fail(closed),
  Ended: (ended) => Result.succeed<EndStep>({ _tag: "Stored", pending: ended.pending }),
})

/**
 * An end withdrawn before it was queued (its caller interrupted while it
 * waited for room): admission reopens, the closing drafts still held, and
 * the attempt before it stays the one the scope's own end tries again.
 */
export const withdrawEnd = (phase: WriterPhase): WriterPhase =>
  WriterPhase.guards.Ending(phase) ? { _tag: "Open", tried: phase.tried, attempted: phase.attempted, closing: phase.closing } : phase

/** What an end's commit plans from: whether the turn tried the inbox items it took, and the drafts it stores before `turn.ended`. */
export interface EndPlan {
  readonly tried: boolean
  readonly closing: ClosingDrafts
}

/**
 * An end's commit plans the turn's close only while the writer is open or
 * ending, from whether the turn tried the inbox items it took and with the
 * closing drafts held; a stopped or ended writer refuses it.
 */
export const endPlanOf = (phase: WriterPhase): Result.Result<EndPlan, WriterStopped> => WriterPhase.match(phase, {
  Open: (open) => Result.succeed({ tried: open.tried, closing: open.closing }),
  Ending: (ending) => Result.succeed({ tried: ending.tried, closing: ending.closing }),
  Failed: (failed) => Result.fail(failed),
  Closed: (closed) => Result.fail(closed),
  Ended: () => Result.fail(sealed),
})

/**
 * An end's commit settled. Stored, the writer has ended. Refused as closed,
 * it is closed so (its closing drafts dropped). Refused otherwise (the store,
 * contention, a defect), it is open again with that ending attempted and its
 * closing drafts still held, so a later end (the scope's own, at the latest)
 * tries them again. A writer that stopped meanwhile stays stopped; an open
 * one (its end withdrawn just as it was queued) ends when that end is stored.
 */
export const endSettled = (phase: WriterPhase, exit: Exit.Exit<{ readonly pending: number }, TurnError>): WriterPhase => WriterPhase.match(phase, {
  Open: (open): WriterPhase => Exit.isSuccess(exit) ? { _tag: "Ended", pending: exit.value.pending } : open,
  Ending: (ending): WriterPhase => Exit.isSuccess(exit) ? { _tag: "Ended", pending: exit.value.pending } : Option.match(Option.filter(Exit.findErrorOption(exit), isClosed), {
    onSome: (closed) => ({ _tag: "Closed", reason: closed.reason }),
    onNone: () => ({ _tag: "Open", tried: ending.tried, attempted: Option.some(ending.ending), closing: ending.closing }),
  }),
  Failed: (failed) => failed,
  Closed: (closed) => closed,
  Ended: (ended) => ended,
})

/** A write failed (the store, contention, a defect) or found the turn closed: an open or ending writer stops with it; the first stop wins, and an ended writer stays ended. */
export const latch = (phase: WriterPhase, error: TurnError): WriterPhase => isLive(phase) ? stopOf(error) : phase

/**
 * Someone else closed the turn (a cancel, a reap, a removal). An open or
 * ending writer closes with `reason`; a stopped one keeps its first stop
 * (the close still settles its waiting callers); one whose end is stored
 * refuses it: nothing is left to close.
 */
export const close = (phase: WriterPhase, reason: ClosedBy): Result.Result<WriterPhase, WriterStopped> =>
  WriterPhase.guards.Ended(phase) ? Result.fail(sealed) : Result.succeed(isLive(phase) ? { _tag: "Closed", reason } : phase)

/** The turn tried the inbox items it took, though it wrote nothing (a drain `run` that interrupted itself). */
export const markTried = (phase: WriterPhase): WriterPhase => isLive(phase) ? { ...phase, tried: true } : phase

/** How a turn whose scope closed before it ended ends: interrupted (`turn.interrupted`) when its scope was interrupted, failed (`turn.unended`) otherwise. */
export const unended = (exit: Exit.Exit<unknown, unknown>): TurnEnding => Exit.hasInterrupts(exit)
  ? { reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "the turn's scope was interrupted before it ended" }) }
  : { reason: "failed", failure: Option.some({ code: "turn.unended", message: "the turn's scope closed before it ended" }) }

/**
 * What the scope's own end stores when the scope closes: an open writer's
 * last attempted ending (one not stored is stored again), else the ending
 * its held reply implies (`replyEndingOf`: completed or partial), else
 * `unended`'s; an ending writer's ending under way. A stopped or ended
 * writer has none: the first refuses its end, the second stored it.
 */
export const scopeEnding = (phase: WriterPhase, exit: Exit.Exit<unknown, unknown>): Option.Option<TurnEnding> => WriterPhase.match(phase, {
  Open: (open) => Option.some(open.attempted.pipe(Option.orElse(() => replyEndingOf(open.closing)), Option.getOrElse(() => unended(exit)))),
  Ending: (ending) => Option.some(ending.ending),
  Failed: () => Option.none(),
  Closed: () => Option.none(),
  Ended: () => Option.none(),
})
