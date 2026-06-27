import { describe, expect, it } from "bun:test"
import { Effect, Ref } from "effect"
import type { AgentBus, AgentResult } from "@xandreed/sdk-core"
import { runFleetToCompletion } from "./fleetCompletion.js"

const result = (text: string): AgentResult => ({
  finalText: text,
  messages: [],
  newTail: [],
})

/**
 * Drive the loop with a fleet that stays outstanding for `phases` rounds. The
 * helper calls `childrenOf` (is a fleet running?) and `awaitChange` (block on
 * it). We model a turn that "spawns a fleet" while rounds remain, an
 * `awaitChange` that finishes the current fleet, and `childrenOf` reading the
 * live flag — so each synthesis turn can leave a NEW fleet for the next round.
 */
const runPhases = (phases: number) =>
  Effect.gen(function* () {
    const running = yield* Ref.make(false)
    const roundsLeft = yield* Ref.make(phases)
    const calls: string[] = []

    const spawnIfRoundsLeft = Ref.modify(roundsLeft, (n) =>
      n > 0 ? [true, n - 1] : [false, 0],
    ).pipe(Effect.flatMap((spawned) => Ref.set(running, spawned)))

    const bus = {
      childrenOf: () =>
        Ref.get(running).pipe(Effect.map((r) => (r ? (["a"] as const) : []))),
      awaitChange: () => Ref.set(running, false),
    } as unknown as AgentBus

    const final = yield* runFleetToCompletion({
      bus,
      rootKey: "conv",
      firstPrompt: "do the task",
      runTurn: (p) =>
        Effect.gen(function* () {
          calls.push(p)
          yield* spawnIfRoundsLeft
          return result(`turn ${calls.length}`)
        }),
    })
    return { final, calls }
  })

describe("runFleetToCompletion — headless auto-block loop", () => {
  it("no outstanding fleet → runs exactly one turn (non-fleet tasks unaffected)", async () => {
    const { final, calls } = await Effect.runPromise(runPhases(0))
    expect(calls).toEqual(["do the task"])
    expect(final.finalText).toBe("turn 1")
  })

  it("one outstanding fleet → waits, then re-runs a synthesis turn", async () => {
    const { final, calls } = await Effect.runPromise(runPhases(1))
    expect(calls.length).toBe(2) // turn 1 + one synthesis turn
    expect(calls[1]).toContain("background agents you spawned") // the CONTINUE prompt
    expect(final.finalText).toBe("turn 2")
  })

  it("a multi-phase fleet loops through several synthesis rounds", async () => {
    const { calls } = await Effect.runPromise(runPhases(3))
    expect(calls.length).toBe(4) // turn 1 + 3 synthesis rounds
  })
})
