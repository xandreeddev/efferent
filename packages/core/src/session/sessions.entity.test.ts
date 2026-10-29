import { describe, expect, test } from "bun:test"
import { Cause, Exit, Option, Schema } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { turnEndingOf } from "./sessions.entity.functions.js"

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
