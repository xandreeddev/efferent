import { describe, expect, test } from "bun:test"
import { Cause, Effect, Option, Schema } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { errorCodeOf, messagesOf, reasonOf } from "./failure.entity.functions.js"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }) {}
class Gone extends Schema.TaggedError<Gone>()("Gone", {}) {}

/** The cause an effect fails with. */
const causeOf = <E>(effect: Effect.Effect<unknown, E>): Cause.Cause<E> =>
  Effect.runSync(Effect.matchCause(effect, { onFailure: (cause) => cause, onSuccess: () => Cause.empty }))

describe("reasonOf", () => {
  test("names a coded error by its code, a tagged one by its tag, an Error subclass by its class", () => {
    expect(reasonOf(Cause.fail(new HarnessError({ code: "events.depth", message: "too deep" })))).toBe("events.depth: too deep")
    expect(reasonOf(Cause.fail(new NotFound({ message: "no such skill" })))).toBe("NotFound: no such skill")
    expect(reasonOf(Cause.fail(new Gone()))).toBe("Gone")
    expect(reasonOf(Cause.die(new TypeError("x is not a function")))).toBe("TypeError: x is not a function")
    expect(reasonOf(Cause.die(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })))).toBe("EACCES: permission denied")
  })

  test("keeps a defect's message and nothing of its stack", () => {
    const defect = new Error("disk on fire\nwhile writing")
    defect.stack = "Error: disk on fire\nwhile writing\n    at writeFixture (stack-redaction-fixture.ts:12:3)"
    const reason = reasonOf(causeOf(Effect.die(defect)))
    expect(defect.stack).toContain("stack-redaction-fixture.ts")
    expect(reason).toBe("disk on fire\nwhile writing")
    expect(reason).not.toContain("stack-redaction-fixture.ts")
  })

  test("reads a HarnessError's message, never its cause's stack", () => {
    const underneath = new Error("the socket closed")
    underneath.stack = "Error: the socket closed\n    at connect (/home/user/project/src/socket.ts:12:3)"
    const reason = reasonOf(Cause.fail(new HarnessError({ code: "loop.failed", message: "the model call failed", cause: underneath })))
    expect(reason).toBe("loop.failed: the model call failed")
    expect(reason).not.toContain("/home/user")
  })

  test("reads strings and other values as Cause.prettyErrors does, and joins several", () => {
    expect(reasonOf(Cause.die("plain text"))).toBe("plain text")
    expect(reasonOf(Cause.die(undefined))).toBe("Unknown error: undefined")
    expect(reasonOf(Cause.combine(Cause.fail(new HarnessError({ code: "a", message: "one" })), Cause.die(new Error("two"))))).toBe("a: one; two")
  })

  test("says interrupted for interruptions alone, and leaves them out beside an error", () => {
    expect(reasonOf(causeOf(Effect.interrupt))).toBe("interrupted")
    expect(reasonOf(Cause.combine(Cause.interrupt(), Cause.fail(new NotFound({ message: "missing" }))))).toBe("NotFound: missing")
    expect(reasonOf(Cause.empty)).toBe("failed without an error")
  })
})

describe("messagesOf", () => {
  test("keeps each error's message alone: no code, tag or class name, nothing of a stack", () => {
    const defect = new Error("disk on fire")
    expect(Array.of<Cause.Cause<unknown>>(
      Cause.fail(new HarnessError({ code: "events.depth", message: "too deep" })),
      Cause.fail(new NotFound({ message: "no such skill" })),
      Cause.fail(new Gone()),
      Cause.die(new TypeError("x is not a function")),
      causeOf(Effect.die(defect)),
      Cause.die("plain text"),
      Cause.combine(Cause.fail(new HarnessError({ code: "a", message: "one" })), Cause.die(new Error("two"))),
      causeOf(Effect.interrupt),
      Cause.empty,
    ).map((cause) => messagesOf(cause))).toEqual([
      "too deep", "no such skill", "an error without a message", "x is not a function", "disk on fire", "plain text", "one; two", "interrupted", "failed without an error",
    ])
  })
})

describe("errorCodeOf", () => {
  test("reads a foreign error's string code only", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
    expect([busy, { code: "ENOENT" }, { code: 32 }, new Error("no code"), "ENOENT", undefined].map(errorCodeOf))
      .toEqual([Option.some("SQLITE_BUSY"), Option.some("ENOENT"), Option.none(), Option.none(), Option.none(), Option.none()])
  })
})
