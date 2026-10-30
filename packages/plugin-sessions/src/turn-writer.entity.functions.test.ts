import { describe, expect, test } from "bun:test"
import { Cause, Exit, Option, Result } from "effect"
import { ConversationId, HarnessError, SessionLogError, TurnClosed } from "@xandreed/core"
import type { TurnEnding, TurnError } from "@xandreed/core"
import { admit, beginEnd, close, endSettled, latch, markTried, opened, scopeEnding, stopped, triedAtEnd, withdrawEnd } from "./turn-writer.entity.functions.js"
import type { EndStep, WriterPhase, WriterStopped } from "./turn-writer.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-0000000000c1")
const completed: TurnEnding = { reason: "completed", failure: Option.none() }
const hostFailed: TurnEnding = { reason: "failed", failure: Option.some({ code: "host.failed", message: "the host failed" }) }
const busy = new SessionLogError({ code: "store.busy", message: "try again" })
const cancelledElsewhere = new TurnClosed({ session, turn: 1, reason: "cancelled" })

// One phase of each kind; `retrying` is open after an end the store refused, `ending` began after it.
const open: WriterPhase = opened
const openTried: WriterPhase = { _tag: "Open", tried: true, attempted: Option.none() }
const retrying: WriterPhase = { _tag: "Open", tried: true, attempted: Option.some(hostFailed) }
const ending: WriterPhase = { _tag: "Ending", tried: true, ending: completed, attempted: Option.some(hostFailed) }
const failed: WriterStopped = { _tag: "Failed", error: busy }
const cancelled: WriterStopped = { _tag: "Closed", reason: "cancelled" }
const ended: WriterPhase = { _tag: "Ended", pending: 2 }
/** The writer's own refusal: `TurnClosed`, `ended`. */
const sealed: WriterStopped = { _tag: "Closed", reason: "ended" }

describe("the writer's phase", () => {
  test("a write is admitted only while the writer is open, marking the turn as having tried when it writes; ending or ended it is sealed, stopped it is refused with the stop", () => {
    const rows: ReadonlyArray<readonly [WriterPhase, boolean, Result.Result<WriterPhase, WriterStopped>]> = [
      [open, false, Result.succeed(open)],
      [open, true, Result.succeed(openTried)],
      [retrying, false, Result.succeed(retrying)],
      [ending, true, Result.fail(sealed)],
      [failed, true, Result.fail(failed)],
      [cancelled, false, Result.fail(cancelled)],
      [ended, false, Result.fail(sealed)],
    ]
    expect(rows.map(([phase, tries]) => admit(phase, tries))).toEqual(rows.map(([, , expected]) => expected))
  })

  test("an end starts on an open writer, keeping the attempt before it; while one is under way it is shared, once stored it is answered, and a stopped writer refuses it", () => {
    const rows: ReadonlyArray<readonly [WriterPhase, Result.Result<EndStep, WriterStopped>]> = [
      [open, Result.succeed({ _tag: "Start", phase: { _tag: "Ending", tried: false, ending: completed, attempted: Option.none() } })],
      [retrying, Result.succeed({ _tag: "Start", phase: { _tag: "Ending", tried: true, ending: completed, attempted: Option.some(hostFailed) } })],
      [ending, Result.succeed({ _tag: "Share" })],
      [failed, Result.fail(failed)],
      [cancelled, Result.fail(cancelled)],
      [ended, Result.succeed({ _tag: "Stored", pending: 2 })],
    ]
    expect(rows.map(([phase]) => beginEnd(phase, completed))).toEqual(rows.map(([, expected]) => expected))
  })

  test("an end's commit settles the writer: stored it has ended, refused as closed it is closed, refused otherwise it is open again with that ending attempted", () => {
    const reopened: WriterPhase = { _tag: "Open", tried: true, attempted: Option.some(completed) }
    const rows: ReadonlyArray<readonly [WriterPhase, Exit.Exit<{ readonly pending: number }, TurnError>, WriterPhase]> = [
      [ending, Exit.succeed({ pending: 1 }), { _tag: "Ended", pending: 1 }],
      [ending, Exit.fail(cancelledElsewhere), cancelled],
      [ending, Exit.fail(busy), reopened],
      [ending, Exit.die(new Error("the store threw")), reopened],
      [ending, Exit.failCause(Cause.interrupt()), reopened],
      // An end withdrawn just as it was queued still ends the writer once stored.
      [open, Exit.succeed({ pending: 0 }), { _tag: "Ended", pending: 0 }],
      [retrying, Exit.fail(busy), retrying],
      // A writer that stopped meanwhile stays stopped; an ended one stays ended.
      [failed, Exit.succeed({ pending: 0 }), failed],
      [cancelled, Exit.succeed({ pending: 0 }), cancelled],
      [ended, Exit.fail(busy), ended],
    ]
    expect(rows.map(([phase, exit]) => endSettled(phase, exit))).toEqual(rows.map(([, , expected]) => expected))
  })

  test("an end withdrawn before it was queued reopens the writer with the attempt before it; nothing else moves", () => {
    const rows: ReadonlyArray<readonly [WriterPhase, WriterPhase]> = [
      [ending, retrying],
      [open, open],
      [failed, failed],
      [cancelled, cancelled],
      [ended, ended],
    ]
    expect(rows.map(([phase]) => withdrawEnd(phase))).toEqual(rows.map(([, expected]) => expected))
  })

  test("a failure stops an open or ending writer, a TurnClosed as closed and anything else as failed; the first stop wins and an ended writer stays ended", () => {
    const defect = new HarnessError({ code: "session.defect", message: "a write died" })
    const rows: ReadonlyArray<readonly [WriterPhase, TurnError, WriterPhase]> = [
      [open, busy, failed],
      [ending, defect, { _tag: "Failed", error: defect }],
      [ending, new TurnClosed({ session, turn: 1, reason: "ended" }), sealed],
      [open, cancelledElsewhere, cancelled],
      [failed, cancelledElsewhere, failed],
      [cancelled, busy, cancelled],
      [ended, busy, ended],
    ]
    expect(rows.map(([phase, error]) => latch(phase, error))).toEqual(rows.map(([, , expected]) => expected))
  })

  test("a close from elsewhere closes an open or ending writer, leaves a stopped one with its first stop, and is refused once the end is stored", () => {
    const rows: ReadonlyArray<readonly [WriterPhase, Result.Result<WriterPhase, WriterStopped>]> = [
      [open, Result.succeed({ _tag: "Closed", reason: "removed" })],
      [ending, Result.succeed({ _tag: "Closed", reason: "removed" })],
      [failed, Result.succeed(failed)],
      [cancelled, Result.succeed(cancelled)],
      [ended, Result.fail(sealed)],
    ]
    expect(rows.map(([phase]) => close(phase, "removed"))).toEqual(rows.map(([, expected]) => expected))
  })

  test("the turn is marked as having tried its items while the writer is open or ending; an end's commit reads it then, and is refused once the writer stopped or ended", () => {
    const tried = [open, ending, failed, ended].map(markTried)
    expect(tried).toEqual([openTried, ending, failed, ended])
    const rows: ReadonlyArray<readonly [WriterPhase, Result.Result<boolean, WriterStopped>]> = [
      [open, Result.succeed(false)],
      [ending, Result.succeed(true)],
      [failed, Result.fail(failed)],
      [cancelled, Result.fail(cancelled)],
      [ended, Result.fail(sealed)],
    ]
    expect(rows.map(([phase]) => triedAtEnd(phase))).toEqual(rows.map(([, expected]) => expected))
  })

  test("only a failed or closed writer refuses every write with its stop", () => {
    expect([open, ending, failed, cancelled, ended].map(stopped)).toEqual([Option.none(), Option.none(), Option.some(failed), Option.some(cancelled), Option.none()])
  })

  test("the scope's own end stores the ending last attempted, the one under way, or the scope's own; a stopped or ended writer has none", () => {
    const interrupted: Exit.Exit<unknown, unknown> = Exit.failCause(Cause.interrupt())
    const rows: ReadonlyArray<readonly [WriterPhase, Exit.Exit<unknown, unknown>, Option.Option<TurnEnding>]> = [
      [open, Exit.void, Option.some({ reason: "failed", failure: Option.some({ code: "turn.unended", message: "the turn's scope closed before it ended" }) })],
      [open, interrupted, Option.some({ reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "the turn's scope was interrupted before it ended" }) })],
      [retrying, interrupted, Option.some(hostFailed)],
      [ending, Exit.void, Option.some(completed)],
      [failed, Exit.void, Option.none()],
      [cancelled, Exit.void, Option.none()],
      [ended, Exit.void, Option.none()],
    ]
    expect(rows.map(([phase, exit]) => scopeEnding(phase, exit))).toEqual(rows.map(([, , expected]) => expected))
  })
})
