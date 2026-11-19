import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { assistantMessage, Seq, stored, storedEvent, ToolCallId, toolResult, turnEndedEvent, TurnNumber, turnStartedEvent, userMessage } from "@xandreed/core"
import type { StoredDraft, StoredEvent, TurnOutcome } from "@xandreed/core"
import { paired } from "../memory/memory.entity.functions.js"
import { turnsOf } from "./turns.entity.functions.js"
import type { TurnRead } from "./turns.entity.js"

/** A journal from drafts, each with the turn it is stored in: places count from one. */
const journalOf = (...records: ReadonlyArray<readonly [turn: number, draft: StoredDraft]>): ReadonlyArray<StoredEvent> =>
  records.map(([turn, draft], index) => ({ ...draft, seq: Seq.make(index + 1), at: 1_767_225_600_000, turn: TurnNumber.make(turn) }))

const started = (turn: number) => stored(turnStartedEvent, { turn: TurnNumber.make(turn) })
const ended = (turn: number, outcome: TurnOutcome = { _tag: "Completed" }) => stored(turnEndedEvent, { turn: TurnNumber.make(turn), outcome })
const calls = (text: string, ...made: ReadonlyArray<readonly [id: string, name: string, params: unknown]>) =>
  assistantMessage(text, { toolCalls: made.map(([id, name, params]) => ({ id, name, params })) })
const result = (id: string, name: string, value: unknown, isFailure = false) => toolResult({ id, name }, value, isFailure)

/** A turn as a test reads it: plain values, each part with its place. */
const told = (turn: TurnRead) => ({
  turn: Number(turn.turn),
  opened: Option.getOrNull(Option.map(turn.opened, Number)),
  messages: turn.messages.map((message) => `#${message.seq} ${message.text}`),
  steps: turn.steps.map((step) => ({
    at: Number(step.seq),
    text: step.text,
    calls: step.calls.map((call) => `${call.id} ${call.name}(${JSON.stringify(call.input)}) ${Option.match(call.result, {
      onNone: () => "no result",
      onSome: (answer) => `#${answer.seq} ${answer.isFailure ? "failed: " : ""}${JSON.stringify(answer.result)}`,
    })}`),
  })),
  answer: Option.getOrNull(turn.answer),
  closed: Option.match(turn.closed, { onNone: () => null, onSome: (closed) => `#${closed.seq} ${closed.outcome._tag}` }),
  records: turn.records.map((record) => Number(record.seq)),
})

describe("a journal as its turns", () => {
  test("a turn is its messages, a step for each answer of the model with its calls and their results, the answer, and how it closed", () => {
    const journal = journalOf(
      [1, started(1)], [1, userMessage("What is 2 + 3?")],
      [1, calls("Let me work that out.", ["c1", "calculator", { a: 2, op: "+", b: 3 }])], [1, result("c1", "calculator", 5)],
      [1, assistantMessage("It is 5.", { model: "scripted", usage: { inputTokens: 40, outputTokens: 4 } })], [1, ended(1)],
      [2, started(2)], [2, userMessage("Thanks.")], [2, assistantMessage("You are welcome.")], [2, ended(2)],
    )
    expect(turnsOf(journal).map(told)).toEqual([
      {
        turn: 1, opened: 1, messages: ["#2 What is 2 + 3?"],
        steps: [
          { at: 3, text: "Let me work that out.", calls: ['c1 calculator({"a":2,"op":"+","b":3}) #4 5'] },
          { at: 5, text: "It is 5.", calls: [] },
        ],
        answer: "It is 5.", closed: "#6 Completed", records: [1, 2, 3, 4, 5, 6],
      },
      { turn: 2, opened: 7, messages: ["#8 Thanks."], steps: [{ at: 9, text: "You are welcome.", calls: [] }], answer: "You are welcome.", closed: "#10 Completed", records: [7, 8, 9, 10] },
    ])
    // What the writer knew of the call that made a step: the model, and its usage; none where it stored none.
    const [first] = turnsOf(journal)
    expect(first?.steps.map((step) => [Option.getOrNull(step.model), Option.getOrNull(step.usage)])).toEqual([[null, null], ["scripted", { inputTokens: 40, outputTokens: 4 }]])
    expect(turnsOf([])).toEqual([])
  })

  test("a message's place orders it against the steps: one that joined the turn after a step, and one stored after the last", () => {
    const journal = journalOf(
      [1, started(1)], [1, userMessage("Look up tides.")], [1, userMessage("And volcanoes.")],
      [1, calls("", ["c1", "lookup", { topic: "tides" }])], [1, result("c1", "lookup", "Tides rise.")],
      [1, userMessage("Shorter, please.")],
      [1, assistantMessage("Tides rise.")],
      [1, userMessage("Still there?")],
    )
    const [turn] = turnsOf(journal)
    expect(turn?.messages.map((message) => [Number(message.seq), message.text])).toEqual([[2, "Look up tides."], [3, "And volcanoes."], [6, "Shorter, please."], [8, "Still there?"]])
    expect(turn?.steps.map((step) => Number(step.seq))).toEqual([4, 7])
    // The messages a step was asked with are those stored before it and after the step before.
    const before = (at: number, after: number) => turn?.messages.filter((message) => message.seq < at && message.seq > after).map((message) => message.text)
    expect([before(4, 0), before(7, 4)]).toEqual([["Look up tides.", "And volcanoes."], ["Shorter, please."]])
    // The turn is open: it has no outcome yet, and its answer is the last step's text.
    expect([Option.isNone(turn?.closed ?? Option.none()), Option.getOrNull(turn?.answer ?? Option.none())]).toEqual([true, "Tides rise."])
  })

  test("a turn with no step has no answer; one that ended on a call has none either, and the call no result", () => {
    const journal = journalOf(
      [1, started(1)], [1, userMessage("Hello.")], [1, ended(1, { _tag: "Failed", reason: "ModelAnswerFailed: the model is down" })],
      [2, started(2)], [2, userMessage("Look up tides.")], [2, calls("One moment.", ["c1", "lookup", { topic: "tides" }])], [2, ended(2, { _tag: "Abandoned" })],
      [3, started(3)], [3, userMessage("Again.")], [3, ended(3, { _tag: "Interrupted" })],
    )
    expect(turnsOf(journal).map(told).map(({ steps, answer, closed }) => ({ steps, answer, closed }))).toEqual([
      { steps: [], answer: null, closed: "#3 Failed" },
      { steps: [{ at: 6, text: "One moment.", calls: ['c1 lookup({"topic":"tides"}) no result'] }], answer: null, closed: "#7 Abandoned" },
      { steps: [], answer: null, closed: "#10 Interrupted" },
    ])
    // The outcome is the record's own: a failure keeps its reason.
    expect(Option.getOrNull(turnsOf(journal)[0]?.closed ?? Option.none())?.outcome).toEqual({ _tag: "Failed", reason: "ModelAnswerFailed: the model is down" })
  })

  test("a failed result is the call's result, marked; several calls of one step each have their own", () => {
    const journal = journalOf(
      [1, started(1)], [1, userMessage("Both.")],
      [1, calls("", ["c1", "calculator", { a: 1, op: "/", b: 0 }], ["c2", "lookup", { topic: "tides" }])],
      [1, result("c2", "lookup", "Tides rise.")], [1, result("c1", "calculator", "division by zero", true)],
      [1, assistantMessage("One failed.")], [1, ended(1)],
    )
    expect(turnsOf(journal).map(told)[0]?.steps[0]?.calls).toEqual([
      'c1 calculator({"a":1,"op":"/","b":0}) #5 failed: "division by zero"',
      'c2 lookup({"topic":"tides"}) #4 "Tides rise."',
    ])
  })

  test("a result answers a call of the latest answer that asked under its id, the first of them with none yet, as the memories pair them: an id asked again in a later turn, and twice in one answer", () => {
    const journal = journalOf(
      // Turn 1 was abandoned inside its call. Turn 2's model asks under the same id, and its result is stored.
      [1, started(1)], [1, userMessage("First.")], [1, calls("", ["c1", "lookup", { topic: "tides" }])], [1, ended(1, { _tag: "Abandoned" })],
      [2, started(2)], [2, userMessage("Second.")], [2, calls("", ["c1", "lookup", { topic: "volcanoes" }])], [2, result("c1", "lookup", "Volcanoes erupt.")],
      // One step asks twice under one id, and one result is stored: it is the first call's, as a loop runs them.
      [2, calls("", ["c2", "calculator", { a: 1, op: "+", b: 1 }], ["c2", "calculator", { a: 2, op: "+", b: 2 }])], [2, result("c2", "calculator", 2)],
      // A result no call asked for, and a second result for a call that has one, answer nothing.
      [2, result("c9", "lookup", "No call.")], [2, result("c1", "lookup", "Again.")],
      [2, assistantMessage("Done.")], [2, ended(2)],
    )
    const turns = turnsOf(journal).map(told)
    expect(turns[0]?.steps[0]?.calls).toEqual(['c1 lookup({"topic":"tides"}) no result'])
    expect(turns[1]?.steps.map((step) => step.calls)).toEqual([
      ['c1 lookup({"topic":"volcanoes"}) #8 "Volcanoes erupt."'],
      ['c2 calculator({"a":1,"op":"+","b":1}) #10 2', 'c2 calculator({"a":2,"op":"+","b":2}) no result'],
      [],
    ])
    // The results that answered nothing are records of their turn, and no call's result.
    expect(turns[1]?.records).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    // The same pairs a memory sends: `paired` keeps exactly the calls that have a result here, and those results.
    const sent = paired(journal.flatMap((record) => (record.message === undefined ? [] : [record.message])))
    const kept = sent.flatMap((message) => (message._tag === "Assistant" ? message.toolCalls.map((call) => `${call.id} ${JSON.stringify(call.input)}`) : []))
    const answered = turnsOf(journal).flatMap((turn) => turn.steps.flatMap((step) => step.calls.filter((call) => Option.isSome(call.result)).map((call) => `${call.id} ${JSON.stringify(call.input)}`)))
    expect(answered).toEqual(['c1 {"topic":"volcanoes"}', 'c2 {"a":1,"op":"+","b":1}'])
    expect(kept).toEqual(answered)
    expect(sent.filter((message) => message._tag === "ToolResult").map((message) => (message._tag === "ToolResult" ? message.result : null))).toEqual(["Volcanoes erupt.", 2])
  })

  test("a record it does not know is in its turn's records and nowhere else: a plugin's own record, read from there with the plugin's definition", () => {
    const noted = storedEvent("test", "noted", { tags: ["trace"], skippable: true, data: Schema.Struct({ note: Schema.String }) })
    const journal = journalOf([1, started(1)], [1, userMessage("Hello.")], [1, stored(noted, { note: "seen" })], [1, assistantMessage("Hi.")], [1, ended(1)])
    const [turn] = turnsOf(journal)
    expect(told(turn!)).toEqual({ turn: 1, opened: 1, messages: ["#2 Hello."], steps: [{ at: 4, text: "Hi.", calls: [] }], answer: "Hi.", closed: "#5 Completed", records: [1, 2, 3, 4, 5] })
    expect(turn?.records.map((record) => String(record.name))).toContain("plugin.test.noted")
  })

  test("a plugin's record that bears a message in the user's or the model's role is no message and no step: the three records of a turn are read by name", () => {
    // Tagged `conversation`, so a memory sends them; neither is something the user said or the model answered.
    const nudged = storedEvent("test", "nudged", { tags: ["conversation"], skippable: false, data: Schema.Struct({}) })
    const journal = journalOf(
      [1, started(1)], [1, userMessage("Hello.")],
      [1, stored(nudged, {}, { message: { _tag: "User", text: "A plugin's note." } })],
      [1, stored(nudged, {}, { message: { _tag: "Assistant", text: "A plugin's words.", toolCalls: [{ id: ToolCallId.make("p1"), name: "lookup", input: {} }] } })],
      [1, stored(nudged, {}, { message: { _tag: "ToolResult", id: ToolCallId.make("p1"), name: "lookup", result: "A plugin's result.", isFailure: false } })],
      [1, calls("", ["p1", "lookup", { topic: "tides" }])],
      [1, assistantMessage("Hi.")], [1, ended(1)],
    )
    expect(turnsOf(journal).map(told)).toEqual([{
      turn: 1, opened: 1, messages: ["#2 Hello."],
      // The plugin's result answers no call of the turn: the model's own call under that id has none.
      steps: [{ at: 6, text: "", calls: ['p1 lookup({"topic":"tides"}) no result'] }, { at: 7, text: "Hi.", calls: [] }],
      answer: "Hi.", closed: "#8 Completed", records: [1, 2, 3, 4, 5, 6, 7, 8],
    }])
  })

  test("it refuses no journal: records are grouped by the turn each names, whatever their place; the first end closes a turn", () => {
    const journal = journalOf(
      // No record opened turn 4: its records are a turn that was never opened.
      [4, userMessage("Out of nowhere.")], [4, assistantMessage("Odd.")],
      [1, started(1)], [1, userMessage("Hello.")], [1, ended(1, { _tag: "Interrupted" })],
      // A second end, and a message stored under the turn after it closed, as no kernel writes them.
      [1, ended(1)], [1, userMessage("Late.")],
      // A record of turn 4 again, later in the journal: the same turn.
      [4, ended(4)],
    )
    expect(turnsOf(journal).map(told)).toEqual([
      { turn: 4, opened: null, messages: ["#1 Out of nowhere."], steps: [{ at: 2, text: "Odd.", calls: [] }], answer: "Odd.", closed: "#8 Completed", records: [1, 2, 8] },
      { turn: 1, opened: 3, messages: ["#4 Hello.", "#7 Late."], steps: [], answer: null, closed: "#5 Interrupted", records: [3, 4, 5, 6, 7] },
    ])
  })
})
