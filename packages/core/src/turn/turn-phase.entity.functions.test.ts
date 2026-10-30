import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"
import type { LogBody, LogEntry, TurnContextBody } from "../memory/memory-log.entity.js"
import type { TurnPhase } from "./turn-phase.entity.js"
import { addContext, claim, heldWith, hold, numberOf, release, reply, sectionsDue, startRun, take } from "./turn-phase.entity.functions.js"
import type { Transition } from "./turn-phase.entity.functions.js"

const note = (text: string): TurnContextBody => ({ _tag: "TurnContext", sectionId: "note", version: "1", text })
const waiting: TurnPhase = { _tag: "Waiting", early: [note("a")] }
const taking: TurnPhase = { _tag: "Taking", early: [note("a")] }
const [first, second, third] = [RunOrdinal.make(0), RunOrdinal.make(1), RunOrdinal.make(2)]
const taken: TurnPhase = { _tag: "Taken", number: 3, sectioned: false, runs: first }
const sectioned: TurnPhase = { _tag: "Taken", number: 3, sectioned: true, runs: first }
const secondRun: TurnPhase = { _tag: "Taken", number: 3, sectioned: true, runs: second }
const entryOf = (n: number, body: LogBody): LogEntry => ({ id: EntryId.make(`run-1:${n}`), runId: RunId.make("run-1"), turn: 3, step: 0, at: 0, body })
const answer = entryOf(4, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("done") })
const later = entryOf(5, note("after the reply"))
const replied: TurnPhase = { _tag: "Replied", number: 3, outcome: "completed", held: [answer, later] }
const unheld: TurnPhase = { _tag: "Replied", number: 3, outcome: "completed", held: [] }
const failedAnswer = entryOf(4, { _tag: "TurnEnded", outcome: "failed", reply: Option.some("done") })

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
    ["Waiting", waiting, "failed", { value: { _tag: "Nothing" }, next: waiting }],
    ["Taking", taking, "failed", { value: { _tag: "Nothing" }, next: taking }],
    ["Taken", sectioned, "failed", { value: { _tag: "Record", number: 3 }, next: { _tag: "Replied", number: 3, outcome: "failed", held: [] } }],
    ["Replied, again", replied, "completed", { value: { _tag: "Nothing" }, next: replied }],
    // A failed reply after a completed one downgrades it: held again under its own id and text, failed.
    ["Replied, failed after completed", replied, "failed", {
      value: { _tag: "Hold", held: [failedAnswer, later] }, next: { _tag: "Replied", number: 3, outcome: "failed", held: [failedAnswer, later] },
    }],
    ["Replied, failed after completed, never held", unheld, "failed", { value: { _tag: "Record", number: 3 }, next: { ...unheld, outcome: "failed" } }],
    ["Replied, never upgraded", { ...unheld, outcome: "failed" }, "completed", { value: { _tag: "Nothing" }, next: { ...unheld, outcome: "failed" } }],
  ] as const)("reply from %s", (_, phase, kind, expected) => {
    expect(outcome(reply(kind)(phase))).toEqual(expected)
  })

  const context = entryOf(6, note("c"))
  test.each([
    ["Taken, an entry", taken, [context], Option.none()],
    ["Taken, a reply on its own", taken, [answer], Option.some([answer])],
    ["Replied", replied, [context], Option.some([answer, later, context])],
    ["Replied, nothing held yet", unheld, [answer], Option.some([answer])],
  ] as const)("heldWith from %s", (_, phase, entries, expected) => {
    expect(heldWith(entries)(phase)).toEqual(expected)
  })

  test("hold keeps what the writer took for the closing commit, in a replied turn only", () => {
    expect([unheld, taken].map(hold([answer, context]))).toEqual([{ ...unheld, held: [answer, context] }, taken])
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
