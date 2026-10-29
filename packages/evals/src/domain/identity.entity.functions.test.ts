import { describe, expect, test } from "bun:test"
import { Cause, Effect, Schema } from "effect"
import { EvaluationError } from "./identity.entity.js"
import { reasonOf } from "./identity.entity.functions.js"

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }) {}
class Gone extends Schema.TaggedError<Gone>()("Gone", {}) {}

/** The cause an effect fails with. */
const causeOf = <E>(effect: Effect.Effect<unknown, E>): Cause.Cause<E> =>
  Effect.runSync(Effect.matchCause(effect, { onFailure: (cause) => cause, onSuccess: () => Cause.empty }))

describe("reasonOf", () => {
  test("names a coded error by its code, a tagged one by its tag, an Error subclass by its class", () => {
    expect(reasonOf(Cause.fail(new EvaluationError({ code: "timeout", message: "Trial deadline exceeded" })))).toBe("timeout: Trial deadline exceeded")
    expect(reasonOf(Cause.fail(new NotFound({ message: "no such fixture" })))).toBe("NotFound: no such fixture")
    expect(reasonOf(Cause.fail(new Gone()))).toBe("Gone")
    expect(reasonOf(Cause.die(new TypeError("x is not a function")))).toBe("TypeError: x is not a function")
    expect(reasonOf(Cause.die(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })))).toBe("EACCES: permission denied")
  })

  test("keeps a defect's message and nothing of its stack", () => {
    // Made here, so its stack names this file.
    const defect = new Error("disk on fire\nwhile writing")
    const reason = reasonOf(causeOf(Effect.die(defect)))
    expect(reason).toBe("disk on fire\nwhile writing")
    expect(reason).not.toContain(import.meta.dir)
    expect(Cause.pretty(Cause.die(defect))).toContain(import.meta.dir)
  })

  test("reads strings and other values as Cause.prettyErrors does, and joins several", () => {
    expect(reasonOf(Cause.die("plain text"))).toBe("plain text")
    expect(reasonOf(Cause.die(undefined))).toBe("Unknown error: undefined")
    expect(reasonOf(Cause.combine(Cause.fail(new EvaluationError({ code: "provider", message: "one" })), Cause.die(new Error("two"))))).toBe("provider: one; two")
  })

  test("says interrupted for interruptions alone, and leaves them out beside an error", () => {
    expect(reasonOf(causeOf(Effect.interrupt))).toBe("interrupted")
    expect(reasonOf(Cause.combine(Cause.interrupt(), Cause.fail(new NotFound({ message: "missing" }))))).toBe("NotFound: missing")
    expect(reasonOf(Cause.empty)).toBe("failed without an error")
  })
})
