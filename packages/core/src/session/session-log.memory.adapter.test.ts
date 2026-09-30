import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionLog } from "../ports/session-log.port.js"
import { sessionLogConformance } from "./session-log.conformance.js"
import { SessionLogMemoryLive } from "./session-log.memory.adapter.js"

describe("the in-memory session log conforms to the SessionLog contract", () => {
  const log = Effect.runSync(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
  sessionLogConformance(log).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the kit catches a backend that breaks the contract", () => {
  const log = Effect.runSync(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
  /** Last write wins: every commit is applied at the head's current revision. */
  const careless = SessionLog.of({
    ...log,
    commit: (id, commit) => log.head(id).pipe(Effect.flatMap((head) => log.commit(id, { ...commit, expect: head.revision }))),
  })
  test("a commit that ignores the revision fails the conflict and race checks", async () => {
    const failed = await Effect.runPromise(Effect.forEach(sessionLogConformance(careless), (check) =>
      Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : []))))
    expect(failed.flat().toSorted()).toEqual(["conflict", "race"])
  })
})
