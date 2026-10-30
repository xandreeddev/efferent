import { describe, expect, test } from "bun:test"
import { Cause, Exit, Option, Result } from "effect"
import { ConversationId, frameworkDraft, HarnessError, SessionLogError, TurnClosed } from "@xandreed/core"
import type { TurnEnding, TurnError } from "@xandreed/core"
import { admit, beginEnd, close, endPlanOf, endSettled, hold, latch, markTried, opened, scopeEnding, stopped, withdrawEnd } from "./turn-writer.entity.functions.js"
import type { EndPlan } from "./turn-writer.entity.functions.js"
import type { ClosingDrafts, EndStep, WriterPhase, WriterStopped } from "./turn-writer.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-0000000000c1")
const completed: TurnEnding = { reason: "completed", failure: Option.none() }
const hostFailed: TurnEnding = { reason: "failed", failure: Option.some({ code: "host.failed", message: "the host failed" }) }
const busy = new SessionLogError({ code: "store.busy", message: "try again" })
const cancelledElsewhere = new TurnClosed({ session, turn: 1, reason: "cancelled" })

/** A reply as the framework's turn holds it for the closing commit (memory's `turn.reply`), with its outcome. */
const replied = (outcome: string): ClosingDrafts => [frameworkDraft("turn.reply", { entry: "run-1:3", runId: "run-1", step: 0, at: 0, body: { outcome, reply: "done" } })]
const answer = replied("completed")

// One phase of each kind; `retrying` is open after an end the store refused, `ending` began after it.
const open: WriterPhase = opened
const openTried: WriterPhase = { _tag: "Open", tried: true, attempted: Option.none(), closing: [] }
const answered: WriterPhase = { _tag: "Open", tried: true, attempted: Option.none(), closing: answer }
const retrying: WriterPhase = { _tag: "Open", tried: true, attempted: Option.some(hostFailed), closing: answer }
const ending: WriterPhase = { _tag: "Ending", tried: true, ending: completed, attempted: Option.some(hostFailed), closing: answer }
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

  test("closing drafts are held only while the writer is open, replacing what it held and marking the turn as having tried; ending or ended it is sealed, stopped it is refused with the stop", () => {
    const rows: ReadonlyArray<readonly [WriterPhase, ClosingDrafts, Result.Result<WriterPhase, WriterStopped>]> = [
      [open, answer, Result.succeed(answered)],
      [open, [], Result.succeed(open)],
      [answered, replied("failed"), Result.succeed({ ...answered, closing: replied("failed") })],
      [retrying, [], Result.succeed({ ...retrying, closing: [] })],
      [ending, answer, Result.fail(sealed)],
      [failed, answer, Result.fail(failed)],
      [cancelled, answer, Result.fail(cancelled)],
      [ended, answer, Result.fail(sealed)],
    ]
    expect(rows.map(([phase, closing]) => hold(phase, closing))).toEqual(rows.map(([, , expected]) => expected))
  })

  test("an end starts on an open writer, keeping the attempt before it and the drafts held; while one is under way it is shared, once stored it is answered, and a stopped writer refuses it", () => {
    const rows: ReadonlyArray<readonly [WriterPhase, Result.Result<EndStep, WriterStopped>]> = [
      [open, Result.succeed({ _tag: "Start", phase: { _tag: "Ending", tried: false, ending: completed, attempted: Option.none(), closing: [] } })],
      [retrying, Result.succeed({ _tag: "Start", phase: { _tag: "Ending", tried: true, ending: completed, attempted: Option.some(hostFailed), closing: answer } })],
      [ending, Result.succeed({ _tag: "Share" })],
      [failed, Result.fail(failed)],
      [cancelled, Result.fail(cancelled)],
      [ended, Result.succeed({ _tag: "Stored", pending: 2 })],
    ]
    expect(rows.map(([phase]) => beginEnd(phase, completed))).toEqual(rows.map(([, expected]) => expected))
  })

  test("an end's commit settles the writer: stored it has ended, refused as closed it is closed (its drafts dropped), refused otherwise it is open again with that ending attempted and its drafts held", () => {
    const reopened: WriterPhase = { _tag: "Open", tried: true, attempted: Option.some(completed), closing: answer }
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

  test("the turn is marked as having tried its items while the writer is open or ending; an end's commit reads it then, with the drafts held, and is refused once the writer stopped or ended", () => {
    const tried = [open, ending, failed, ended].map(markTried)
    expect(tried).toEqual([openTried, ending, failed, ended])
    const rows: ReadonlyArray<readonly [WriterPhase, Result.Result<EndPlan, WriterStopped>]> = [
      [open, Result.succeed({ tried: false, closing: [] })],
      [answered, Result.succeed({ tried: true, closing: answer })],
      [ending, Result.succeed({ tried: true, closing: answer })],
      [failed, Result.fail(failed)],
      [cancelled, Result.fail(cancelled)],
      [ended, Result.fail(sealed)],
    ]
    expect(rows.map(([phase]) => endPlanOf(phase))).toEqual(rows.map(([, expected]) => expected))
  })

  test("only a failed or closed writer refuses every write with its stop", () => {
    expect([open, ending, failed, cancelled, ended].map(stopped)).toEqual([Option.none(), Option.none(), Option.some(failed), Option.some(cancelled), Option.none()])
  })

  test("the scope's own end stores the ending last attempted, the one under way, the one its held reply implies, or the scope's own; a stopped or ended writer has none", () => {
    const interrupted: Exit.Exit<unknown, unknown> = Exit.failCause(Cause.interrupt())
    const unended: TurnEnding = { reason: "failed", failure: Option.some({ code: "turn.unended", message: "the turn's scope closed before it ended" }) }
    const rows: ReadonlyArray<readonly [WriterPhase, Exit.Exit<unknown, unknown>, Option.Option<TurnEnding>]> = [
      [open, Exit.void, Option.some(unended)],
      [open, interrupted, Option.some({ reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "the turn's scope was interrupted before it ended" }) })],
      [answered, interrupted, Option.some(completed)],
      [{ ...answered, closing: replied("partial") }, Exit.void, Option.some({ reason: "partial", failure: Option.none() })],
      // A failed reply implies no ending of its own: how the turn failed is the scope's.
      [{ ...answered, closing: replied("failed") }, Exit.void, Option.some(unended)],
      [retrying, interrupted, Option.some(hostFailed)],
      [ending, Exit.void, Option.some(completed)],
      [failed, Exit.void, Option.none()],
      [cancelled, Exit.void, Option.none()],
      [ended, Exit.void, Option.none()],
    ]
    expect(rows.map(([phase, exit]) => scopeEnding(phase, exit))).toEqual(rows.map(([, , expected]) => expected))
  })
})
