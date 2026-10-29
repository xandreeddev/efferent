import { describe, expect, test } from "bun:test"
import { Cause, Exit, Option, Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { SessionLogError } from "./session-log.entity.js"
import { ReservedKind, SessionBusy, SessionContended, TurnClosed } from "./sessions.entity.js"
import { resumeRefusal, turnEndingOf } from "./sessions.entity.functions.js"
import type { ResumableTurn } from "./sessions.entity.functions.js"
import type { TurnEndReason } from "./session-event.entity.js"

class Untold extends Schema.TaggedError<Untold>()("Untold", { attempt: Schema.Number }) {}
class Explained extends Schema.TaggedError<Explained>()("Explained", { message: Schema.String }) {}

const failure = (exit: Exit.Exit<{ readonly outcome: "completed" | "partial" | "failed" }, unknown>) => {
  const ending = turnEndingOf(exit)
  return [ending.reason, Option.getOrNull(ending.failure)]
}

describe("turnEndingOf", () => {
  test("a success ends with the outcome it returned, and no failure", () => {
    expect(turnEndingOf(Exit.succeed({ outcome: "completed" }))).toEqual({ reason: "completed", failure: Option.none() })
    expect(turnEndingOf(Exit.succeed({ outcome: "partial" }))).toEqual({ reason: "partial", failure: Option.none() })
    expect(turnEndingOf(Exit.succeed({ outcome: "failed" }))).toEqual({ reason: "failed", failure: Option.none() })
  })

  test("an error with a code keeps its code and message", () => {
    expect(failure(Exit.fail(new HarnessError({ code: "reaction.failed", message: "broken" }))))
      .toEqual(["failed", { code: "reaction.failed", message: "broken" }])
  })

  test("a message is cut to 500 characters", () => {
    const [, stored] = failure(Exit.fail(new HarnessError({ code: "host.failed", message: "x".repeat(2_000) })))
    expect(stored).toEqual({ code: "host.failed", message: "x".repeat(500) })
  })

  test("an error without a code is turn.failed, named by its tag", () => {
    expect(failure(Exit.fail(new Explained({ message: "the model is down" })))).toEqual(["failed", { code: "turn.failed", message: "Explained: the model is down" }])
    expect(failure(Exit.fail(new Untold({ attempt: 2 })))).toEqual(["failed", { code: "turn.failed", message: "Untold: {\"attempt\":2}" }])
    expect(failure(Exit.fail("the model is down"))).toEqual(["failed", { code: "turn.failed", message: "the model is down" }])
  })

  test("a begin refusal, TurnClosed and ReservedKind store the code their tag stands for, from any copy of core", () => {
    const session = ConversationId.make("00000000-0000-4000-8000-0000000000b1")
    expect(failure(Exit.fail(new SessionBusy({ session, turn: 2 })))).toEqual(["failed", { code: "session.busy", message: `SessionBusy: {"session":"${session}","turn":2}` }])
    expect(failure(Exit.fail(new SessionContended({ session, attempts: 5 })))[1]).toMatchObject({ code: "session.contended" })
    expect(failure(Exit.fail(new TurnClosed({ session, turn: 2, reason: "cancelled" })))[1]).toMatchObject({ code: "turn.closed" })
    expect(failure(Exit.fail(new ReservedKind({ kind: "turn.ended" })))[1]).toEqual({ code: "events.reserved", message: `ReservedKind: {"kind":"turn.ended"}` })
    expect(failure(Exit.fail({ _tag: "TurnClosed", session, turn: 2, reason: "removed" }))[1]).toMatchObject({ code: "turn.closed" })
  })

  test("a store failure is session.log, with the store's message", () => {
    expect(failure(Exit.fail(new SessionLogError({ code: "store.io", message: "disk full" })))).toEqual(["failed", { code: "session.log", message: "disk full" }])
  })

  test("an untagged value's code is not stored: it is turn.failed, with its message", () => {
    expect(failure(Exit.fail({ code: "ENOENT", message: "no such file" }))).toEqual(["failed", { code: "turn.failed", message: "no such file" }])
    expect(failure(Exit.fail(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })))).toEqual(["failed", { code: "turn.failed", message: "database is locked" }])
  })

  test("a defect is turn.defect", () => {
    expect(failure(Exit.die(new Error("boom")))).toEqual(["failed", { code: "turn.defect", message: "Error: boom" }])
  })

  test("an interruption alone ends interrupted", () => {
    expect(failure(Exit.interrupt())).toEqual(["interrupted", { code: "turn.interrupted", message: "the turn was interrupted" }])
  })

  test("an error wins over an interruption in the same cause", () => {
    const cause = Cause.combine(Cause.interrupt(), Cause.fail(new HarnessError({ code: "turn.closed", message: "turn 1 was cancelled" })))
    expect(failure(Exit.failCause(cause))).toEqual(["failed", { code: "turn.closed", message: "turn 1 was cancelled" }])
    expect(failure(Exit.failCause(Cause.combine(Cause.interrupt(), Cause.die("lost"))))[1]).toMatchObject({ code: "turn.defect" })
  })
})

describe("resumeRefusal", () => {
  const user = (turn: number, ended?: TurnEndReason): ResumableTurn =>
    ({ turn, origin: "user", resumes: Option.none(), ended: Option.fromNullishOr(ended) })
  const resuming = (turn: number, resumes: number, ended?: TurnEndReason): ResumableTurn =>
    ({ ...user(turn, ended), resumes: Option.some(resumes) })
  const inbox = (turn: number): ResumableTurn => ({ turn, origin: "inbox", resumes: Option.none(), ended: Option.some("completed") })

  test("the last user's turn, ended cancelled or interrupted, can be resumed, even with inbox turns after it", () => {
    expect(resumeRefusal(2, [user(1, "completed"), user(2, "cancelled")])).toEqual(Option.none())
    expect(resumeRefusal(2, [user(1, "completed"), user(2, "interrupted")])).toEqual(Option.none())
    expect(resumeRefusal(1, [user(1, "interrupted"), inbox(2), inbox(3)])).toEqual(Option.none())
  })

  test("a turn the session does not hold is missing", () => {
    expect(resumeRefusal(3, [user(1, "cancelled")])).toEqual(Option.some("missing"))
    expect(resumeRefusal(0, [user(1, "cancelled")])).toEqual(Option.some("missing"))
    expect(resumeRefusal(1, [])).toEqual(Option.some("missing"))
    expect(resumeRefusal(1.5, [user(1, "cancelled"), user(2, "cancelled")])).toEqual(Option.some("missing"))
    expect(resumeRefusal(Number.NaN, [user(1, "cancelled")])).toEqual(Option.some("missing"))
  })

  test("an inbox turn is refused as inbox, before anything else", () => {
    expect(resumeRefusal(2, [user(1, "completed"), { turn: 2, origin: "inbox", resumes: Option.none(), ended: Option.some("interrupted") }, user(3, "completed")])).toEqual(Option.some("inbox"))
  })

  test("a turn a user's turn followed is superseded, however each ended", () => {
    expect(resumeRefusal(1, [user(1, "cancelled"), user(2, "cancelled")])).toEqual(Option.some("superseded"))
    expect(resumeRefusal(1, [user(1, "interrupted"), inbox(2), user(3, "failed")])).toEqual(Option.some("superseded"))
  })

  test("a resume of the turn that failed, was cancelled or was interrupted does not supersede it: the resume can be tried again", () => {
    expect(resumeRefusal(1, [user(1, "cancelled"), resuming(2, 1, "failed")])).toEqual(Option.none())
    expect(resumeRefusal(1, [user(1, "cancelled"), resuming(2, 1, "cancelled"), inbox(3), resuming(4, 1, "interrupted")])).toEqual(Option.none())
    // The stopped resume itself can be resumed too, and then the turn it resumed is superseded by that resume's resume.
    expect(resumeRefusal(2, [user(1, "cancelled"), resuming(2, 1, "cancelled")])).toEqual(Option.none())
    expect(resumeRefusal(1, [user(1, "cancelled"), resuming(2, 1, "cancelled"), resuming(3, 2, "failed")])).toEqual(Option.some("superseded"))
    expect(resumeRefusal(2, [user(1, "cancelled"), resuming(2, 1, "cancelled"), resuming(3, 2, "failed")])).toEqual(Option.none())
  })

  test("a resume of the turn that completed, ended partial or has no end supersedes it, and so does any other user's turn", () => {
    expect(resumeRefusal(1, [user(1, "cancelled"), resuming(2, 1, "completed")])).toEqual(Option.some("superseded"))
    expect(resumeRefusal(1, [user(1, "cancelled"), resuming(2, 1, "partial")])).toEqual(Option.some("superseded"))
    expect(resumeRefusal(1, [user(1, "cancelled"), resuming(2, 1)])).toEqual(Option.some("superseded"))
    expect(resumeRefusal(1, [user(1, "cancelled"), resuming(2, 1, "failed"), user(3, "completed")])).toEqual(Option.some("superseded"))
  })

  test("a turn that ended completed, partial or failed, or has not ended, is finished", () => {
    expect(resumeRefusal(1, [user(1, "completed")])).toEqual(Option.some("finished"))
    expect(resumeRefusal(1, [user(1, "partial")])).toEqual(Option.some("finished"))
    expect(resumeRefusal(1, [user(1, "failed")])).toEqual(Option.some("finished"))
    expect(resumeRefusal(1, [user(1)])).toEqual(Option.some("finished"))
  })
})
