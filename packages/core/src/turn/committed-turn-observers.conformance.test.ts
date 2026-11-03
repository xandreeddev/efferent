import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommittedTurnObservers } from "../ports/committed-turn-observers.port.js"
import { notifyCommittedTurn } from "./committed-turn.entity.functions.js"
import { committedTurnObserversConformance } from "./committed-turn-observers.conformance.js"
import type { CommittedTurnNotifier } from "./committed-turn-observers.conformance.js"

const notify: CommittedTurnNotifier = (turn, observers) => notifyCommittedTurn(turn).pipe(Effect.provideService(CommittedTurnObservers, observers))

describe("committedTurnObserversConformance", () => {
  committedTurnObserversConformance(notify).forEach((check) => test(check.name, () => Effect.runPromise(check.run)))

  test("the checks have stable names and reject a notifier that drops every callback", async () => {
    const checks = committedTurnObserversConformance(() => Effect.void)
    expect(checks.map((check) => check.name)).toEqual([
      "committed observers preserve order", "committed observers receive independent snapshots", "committed observer failures are soft", "committed observer waits are bounded",
    ])
    const results = await Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.every((result) => result._tag === "Failure")).toBe(true)
  })
})
