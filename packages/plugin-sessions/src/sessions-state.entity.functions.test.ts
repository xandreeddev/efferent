import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { InboxItemId, RunId } from "@xandreed/core"
import type { TurnEndReason } from "@xandreed/core"
import { closedState } from "./sessions-state.entity.functions.js"
import type { SessionsState } from "./sessions-state.entity.js"

const held = (delivery?: "steer" | "next"): SessionsState => ({
  v: 1, turns: 1, title: Option.none(),
  open: Option.some({ turn: 1, runId: RunId.make("queued-state"), key: "input:one", origin: "user", holder: "holder", expiresAt: Option.none(), process: Option.none() }),
  inbox: [{ id: InboxItemId.make("one"), attempts: 10, claimedBy: Option.some(1), ...(delivery === undefined ? {} : { delivery }) }],
})

describe("queued input closure", () => {
  test.each(["failed", "partial", "interrupted"] as const)("%s returns either input delivery to wait beyond the notice attempt cap", (reason) => {
    (["steer", "next"] as const).forEach((delivery) => {
      const next = closedState(held(delivery), reason, 2, true)
      expect(next.dropped).toEqual([])
      expect(next.state.inbox).toEqual([{ id: InboxItemId.make("one"), delivery, attempts: 11, claimedBy: Option.none() }])
      expect(next.state.open).toEqual(Option.none())
    })
  })

  test.each(["completed", "cancelled", "waiting"] as const)("%s acknowledges queued input", (reason) => {
    expect(closedState(held("next"), reason, 2, true).state.inbox).toEqual([])
  })

  test("legacy notice closure retains its existing acknowledgement and drop policy", () => {
    const endings: ReadonlyArray<TurnEndReason> = ["completed", "partial", "cancelled", "waiting", "failed", "interrupted"]
    expect(endings.map((reason) => closedState(held(), reason, 2, true))).toEqual(endings.map((reason) => ({
      state: { ...held(), open: Option.none(), inbox: [] },
      dropped: reason === "failed" || reason === "interrupted" ? [InboxItemId.make("one")] : [],
    })))
    const untried = closedState(held("next"), "interrupted", 2, false)
    expect(untried.state.inbox[0]?.attempts).toBe(10)
  })

  test("waiting acknowledges this turn's input and notices, preserving an early answer and another turn's claim", () => {
    const state = held("next")
    const early = { id: InboxItemId.make("early-answer"), attempts: 0, claimedBy: Option.none(), delivery: "next" as const }
    const foreign = { id: InboxItemId.make("foreign"), attempts: 0, claimedBy: Option.some(2), delivery: "steer" as const }
    const notice = { id: InboxItemId.make("notice"), attempts: 0, claimedBy: Option.some(1) }
    const next = closedState({ ...state, inbox: [...state.inbox, notice, early, foreign] }, "waiting", 2, true)
    expect(next.state.inbox).toEqual([early, foreign])
    expect(next.dropped).toEqual([])
  })
})
