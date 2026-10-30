import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import type { TurnContextBody } from "../memory/memory-log.entity.js"
import type { TurnPhase } from "./turn-phase.entity.js"
import { addContext, claim, numberOf, release, reply, sectionsDue, startRun, take } from "./turn-phase.entity.functions.js"
import type { Transition } from "./turn-phase.entity.functions.js"

const note = (text: string): TurnContextBody => ({ _tag: "TurnContext", sectionId: "note", version: "1", text })
const waiting: TurnPhase = { _tag: "Waiting", early: [note("a")] }
const taking: TurnPhase = { _tag: "Taking", early: [note("a")] }
const [first, second, third] = [RunOrdinal.make(0), RunOrdinal.make(1), RunOrdinal.make(2)]
const taken: TurnPhase = { _tag: "Taken", number: 3, sectioned: false, runs: first }
const sectioned: TurnPhase = { _tag: "Taken", number: 3, sectioned: true, runs: first }
const secondRun: TurnPhase = { _tag: "Taken", number: 3, sectioned: true, runs: second }
const replied: TurnPhase = { _tag: "Replied", number: 3, outcome: "completed" }

/** A transition's result as data: what it returns and where it moves, or the code it is refused with. */
const outcome = <A>(transition: Transition<A>) => Result.match(transition, {
  onFailure: (error) => ({ refused: error.code }),
  onSuccess: ([value, next]) => ({ value, next }),
})

describe("TurnPhase transitions", () => {
  test.each([
    ["Waiting", waiting, { value: undefined, next: { _tag: "Taking", early: [note("a")] } }],
    ["Taking", taking, { refused: "turn.persisted" }],
    ["Taken", taken, { refused: "turn.persisted" }],
    ["Replied", replied, { refused: "turn.persisted" }],
  ] as const)("claim from %s", (_, phase, expected) => {
    expect(outcome(claim(phase))).toEqual(expected)
  })

  test.each([
    ["Waiting", waiting, waiting],
    ["Taking", taking, { _tag: "Waiting", early: [note("a")] }],
    ["Taken", taken, taken],
    ["Replied", replied, replied],
  ] as const)("release from %s", (_, phase, expected) => {
    expect(release(phase)).toEqual(expected)
  })

  test.each([
    ["Waiting", waiting, { refused: "turn.unstarted" }],
    ["Taking", taking, { value: [note("a")], next: taken }],
    ["Taken", taken, { refused: "turn.persisted" }],
    ["Replied", replied, { refused: "turn.persisted" }],
  ] as const)("take from %s", (_, phase, expected) => {
    expect(outcome(take(3)(phase))).toEqual(expected)
  })

  test.each([
    ["Waiting", waiting, { value: [], next: { _tag: "Waiting", early: [note("a"), note("b")] } }],
    ["Taking", taking, { value: [], next: { _tag: "Taking", early: [note("a"), note("b")] } }],
    ["Taken", taken, { value: [note("b")], next: taken }],
    ["Replied", replied, { value: [note("b")], next: replied }],
  ] as const)("addContext from %s", (_, phase, expected) => {
    expect(outcome(addContext(note("b"))(phase))).toEqual(expected)
  })

  test.each([
    ["Waiting", waiting, { refused: "turn.unstarted" }],
    ["Taking", taking, { refused: "turn.unstarted" }],
    ["Taken, not sectioned", taken, { value: true, next: sectioned }],
    ["Taken, sectioned", sectioned, { value: false, next: sectioned }],
    ["Replied", replied, { value: false, next: replied }],
  ] as const)("sectionsDue from %s", (_, phase, expected) => {
    expect(outcome(sectionsDue(phase))).toEqual(expected)
  })

  test.each([
    ["Waiting", waiting, { value: Option.none(), next: waiting }],
    ["Taking", taking, { value: Option.none(), next: taking }],
    ["Taken", sectioned, { value: Option.some(3), next: { _tag: "Replied", number: 3, outcome: "failed" } }],
    ["Replied", replied, { value: Option.none(), next: replied }],
  ] as const)("reply from %s", (_, phase, expected) => {
    expect(outcome(reply("failed")(phase))).toEqual(expected)
  })

  const runId = RunId.make("run-1")
  test.each([
    ["Waiting", waiting, { refused: "turn.unstarted" }],
    ["Taking", taking, { refused: "turn.unstarted" }],
    ["Taken, no run yet", sectioned, { value: { id: runId, turn: 3, ordinal: first }, next: secondRun }],
    ["Taken, after a run", secondRun, { value: { id: runId, turn: 3, ordinal: second }, next: { ...secondRun, runs: third } }],
    ["Replied", replied, { refused: "turn.closed" }],
  ] as const)("startRun from %s", (_, phase, expected) => {
    expect(outcome(startRun(runId)(phase))).toEqual(expected)
  })

  test("the number is known once the message is taken", () => {
    expect([waiting, taking, taken, replied].map(numberOf)).toEqual([Option.none(), Option.none(), Option.some(3), Option.some(3)])
  })
})
