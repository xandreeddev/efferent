import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { stored, storedEvent } from "./event.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { EventName, Owner, Seq, SessionId, TurnNumber } from "./ids.entity.js"
import { beginTurn, endTurn, inspectionOf, newSession, sessionStateOf } from "./session.entity.functions.js"
import { JOURNAL_FORMAT } from "./session.entity.js"
import type { SessionHeader, SessionState } from "./session.entity.js"
import { turnEnded, turnStarted } from "./vocabulary.entity.functions.js"

const free = (turns: number): SessionState => ({ _tag: "Free", turns })
const open = (turn: number): SessionState => ({ _tag: "TurnOpen", turn: TurnNumber.make(turn) })

/** What a transition or a fold gave: the state, or the reason or tag it refused with. */
const told = (result: Result.Result<SessionState, { readonly _tag: string; readonly reason?: string }>): SessionState | string =>
  Result.match(result, { onSuccess: (state): SessionState | string => state, onFailure: (refusal) => refusal.reason ?? refusal._tag })

/** Drafts as a journal: each at the next place. */
const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, turn: TurnNumber.make(1), ...draft }))

/** A plugin's record bearing a message: whatever a workflow appends inside a turn, as far as core knows. */
const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({ text: Schema.String }), skippable: false })
const note = (text: string) => stored(noted, { text }, { message: { _tag: "User", text } })

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
  /** A record under core's prefix that this release does not know: one a later core may write. */
  const future = (skippable: boolean) =>
    stored({ ...storedEvent("any", "future", { tags: ["trace"], data: Schema.Struct({}), skippable }), name: EventName.make("core.session.future") }, {})
  const elsewhere = stored(storedEvent("elsewhere", "noted", { tags: ["trace"], data: Schema.Struct({}), skippable: false }), {})

  const table: ReadonlyArray<readonly [string, ReadonlyArray<StoredDraft>, SessionState | string]> = [
    ["an empty journal", [], free(0)],
    ["a turn that started", [turnStarted(turn(1))], open(1)],
    ["a turn that started and ended", [turnStarted(turn(1)), turnEnded(turn(1), completed)], free(1)],
    ["a turn's other records change nothing", [turnStarted(turn(1)), note("Hello"), note("Hi"), turnEnded(turn(1), completed)], free(1)],
    ["two turns and a third open", [turnStarted(turn(1)), turnEnded(turn(1), { _tag: "Failed", reason: "x" }), turnStarted(turn(2)), turnEnded(turn(2), { _tag: "Interrupted" }), turnStarted(turn(3))], open(3)],
    ["an end with no start is refused as the transition refuses it", [turnEnded(turn(1), completed)], "NoOpenTurn"],
    ["a start inside an open turn is refused as the transition refuses it", [turnStarted(turn(1)), turnStarted(turn(2))], "SessionBusy"],
    ["an unknown core record that may be skipped", [turnStarted(turn(1)), future(true), turnEnded(turn(1), completed)], free(1)],
    ["an unknown core record that may not be skipped", [turnStarted(turn(1)), future(false), turnEnded(turn(1), completed)], "UnknownRecord"],
    ["a plugin's record, whatever it says", [turnStarted(turn(1)), elsewhere], open(1)],
  ]

  table.forEach(([name, drafts, state]) => {
    test(name, () => {
      expect(told(sessionStateOf(journal(...drafts)))).toEqual(state)
    })
  })

  test("equals the transitions applied in order, for every run of turns up to six", () => {
    // Every journal of up to six whole turns, each followed by one left open: the fold is the transitions, one by one.
    Array.from({ length: 7 }, (_, turns) => turns).forEach((turns) => {
      const whole = Array.from({ length: turns }, (_, index) => [turnStarted(turn(index + 1)), note(`m${index}`), turnEnded(turn(index + 1), completed)]).flat()
      expect(told(sessionStateOf(journal(...whole)))).toEqual(free(turns))
      expect(told(sessionStateOf(journal(...whole, turnStarted(turn(turns + 1)))))).toEqual(told(beginTurn(free(turns))))
    })
  })
})

describe("inspecting a session", () => {
  const header: SessionHeader = { id: SessionId.make("s-1"), owner: Owner.make("learner"), format: JOURNAL_FORMAT }

  test("gives its header, the state its journal folds to and its events", () => {
    const events = journal(turnStarted(TurnNumber.make(1)), note("Hello"), turnEnded(TurnNumber.make(1), { _tag: "Completed" }), turnStarted(TurnNumber.make(2)))
    const inspection = Result.getOrThrow(inspectionOf({ header, events }))
    expect(inspection).toEqual({ header, state: { _tag: "TurnOpen", turn: TurnNumber.make(2) }, events })
  })

  test("refuses a journal the session's transitions do not allow", () => {
    const told = (...drafts: ReadonlyArray<StoredDraft>) => Result.match(inspectionOf({ header, events: journal(...drafts) }), { onSuccess: () => "inspected", onFailure: (refusal) => refusal._tag })
    expect(told(turnEnded(TurnNumber.make(1), { _tag: "Completed" }))).toBe("SessionRefused")
  })
})
