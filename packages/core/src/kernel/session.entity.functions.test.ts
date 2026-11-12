import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { stored, storedEvent } from "./event.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { firstStep } from "./ids.entity.functions.js"
import { Seq, Tokens, TurnNumber } from "./ids.entity.js"
import { beginTurn, endTurn, newSession, sessionStateOf } from "./session.entity.functions.js"
import type { SessionState } from "./session.entity.js"
import { assistantMessage, requestSent, turnEnded, turnStarted, userMessage } from "./vocabulary.entity.functions.js"

const free = (turns: number): SessionState => ({ _tag: "Free", turns })
const open = (turn: number): SessionState => ({ _tag: "TurnOpen", turn: TurnNumber.make(turn) })

/** What a transition or a fold gave: the state, or the reason or tag it refused with. */
const told = (result: Result.Result<SessionState, { readonly _tag: string; readonly reason?: string }>): SessionState | string =>
  Result.match(result, { onSuccess: (state): SessionState | string => state, onFailure: (refusal) => refusal.reason ?? refusal._tag })

/** Drafts as a journal: each at the next place. */
const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, ...draft }))

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
    const first = Result.getOrThrow(beginTurn(newSession))
    const after = Result.getOrThrow(endTurn(first))
    expect(told(beginTurn(after))).toEqual(open(2))
  })
})

describe("the fold of a journal to a session's state", () => {
  const turn = (number: number) => TurnNumber.make(number)
  const completed = { _tag: "Completed" as const }
  const future = (skippable: boolean) => stored(storedEvent("session", "future", { data: Schema.Struct({}), skippable }), {})
  const elsewhere = stored(storedEvent("elsewhere", "noted", { data: Schema.Struct({}), skippable: false }), {})

  const table: ReadonlyArray<readonly [string, ReadonlyArray<StoredDraft>, SessionState | string]> = [
    ["an empty journal", [], free(0)],
    ["a turn that started", [turnStarted(turn(1))], open(1)],
    ["a turn that started and ended", [turnStarted(turn(1)), turnEnded(turn(1), completed)], free(1)],
    ["a turn's other records change nothing", [turnStarted(turn(1)), userMessage("Hello"), requestSent(firstStep, "", { messages: [], estimatedTokens: Tokens.make(0), budgetTokens: Tokens.make(0) }), assistantMessage(firstStep, { _tag: "Assistant", text: "Hi", toolCalls: [] }), turnEnded(turn(1), completed)], free(1)],
    ["two turns and a third open", [turnStarted(turn(1)), turnEnded(turn(1), { _tag: "Failed", reason: "x" }), turnStarted(turn(2)), turnEnded(turn(2), { _tag: "Interrupted" }), turnStarted(turn(3))], open(3)],
    ["an end with no start is refused as the transition refuses it", [turnEnded(turn(1), completed)], "NoOpenTurn"],
    ["a start inside an open turn is refused as the transition refuses it", [turnStarted(turn(1)), turnStarted(turn(2))], "SessionBusy"],
    ["an unknown record of the session plugin that may be skipped", [turnStarted(turn(1)), future(true), turnEnded(turn(1), completed)], free(1)],
    ["an unknown record of the session plugin that may not be skipped", [turnStarted(turn(1)), future(false), turnEnded(turn(1), completed)], "UnknownRecord"],
    ["another plugin's record, whatever it says", [turnStarted(turn(1)), elsewhere], open(1)],
  ]

  table.forEach(([name, drafts, state]) => {
    test(name, () => {
      expect(told(sessionStateOf(journal(...drafts)))).toEqual(state)
    })
  })

  test("equals the transitions applied in order, for every run of turns up to six", () => {
    // Every journal of up to six whole turns, each followed by one left open: the fold is the transitions, one by one.
    Array.from({ length: 7 }, (_, turns) => turns).forEach((turns) => {
      const whole = Array.from({ length: turns }, (_, index) => [turnStarted(turn(index + 1)), userMessage(`m${index}`), turnEnded(turn(index + 1), completed)]).flat()
      expect(told(sessionStateOf(journal(...whole)))).toEqual(free(turns))
      expect(told(sessionStateOf(journal(...whole, turnStarted(turn(turns + 1)))))).toEqual(told(beginTurn(free(turns))))
    })
  })
})
