import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { TurnNumber } from "./ids.entity.js"
import { beginTurn, endTurn } from "./session.entity.functions.js"
import type { SessionState } from "./session.entity.js"

const free = (turns: number): SessionState => ({ _tag: "Free", turns })
const open = (turn: number): SessionState => ({ _tag: "TurnOpen", turn: TurnNumber.make(turn) })

/** What a transition gave: the next state, or the reason it refused. */
const told = (result: Result.Result<SessionState, { readonly reason: string }>): SessionState | string =>
  Result.match(result, { onSuccess: (state): SessionState | string => state, onFailure: (refusal) => refusal.reason })

describe("a session's state", () => {
  const table: ReadonlyArray<readonly [string, SessionState, SessionState | string, SessionState | string]> = [
    // the state, after beginTurn, after endTurn
    ["a new session", free(0), open(1), "NoOpenTurn"],
    ["a session after two turns", free(2), open(3), "NoOpenTurn"],
    ["a session in its first turn", open(1), "SessionBusy", free(1)],
    ["a session in its third turn", open(3), "SessionBusy", free(3)],
  ]

  table.forEach(([name, state, begun, ended]) => {
    test(name, () => {
      expect(told(beginTurn(state))).toEqual(begun)
      expect(told(endTurn(state))).toEqual(ended)
    })
  })

  test("turns open and close one after another, numbered from 1", () => {
    const first = Result.getOrThrow(beginTurn(free(0)))
    const after = Result.getOrThrow(endTurn(first))
    expect(told(beginTurn(after))).toEqual(open(2))
  })
})
