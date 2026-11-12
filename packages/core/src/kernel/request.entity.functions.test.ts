import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { dataOf } from "./event.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { firstStep } from "./ids.entity.functions.js"
import { Owner, Seq, SessionId, Tokens, TurnNumber } from "./ids.entity.js"
import { estimateRequest, estimateTokens, inspectionOf, resolveRequest, turnMessageOf } from "./request.entity.functions.js"
import { JOURNAL_FORMAT } from "./session.entity.js"
import type { SessionHeader } from "./session.entity.js"
import { assistantMessage, requestSent, turnEnded, turnStarted, userMessage } from "./vocabulary.entity.functions.js"
import { requestSentEvent } from "./vocabulary.entity.js"

const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, ...draft }))
const answer = (text: string) => assistantMessage(firstStep, { _tag: "Assistant", text, toolCalls: [] })
const request = (...messages: ReadonlyArray<number>) => ({ system: "Be brief.", messages: messages.map((seq) => Seq.make(seq)), estimatedTokens: Tokens.make(7), budgetTokens: Tokens.make(100) })

describe("the estimate", () => {
  const table: ReadonlyArray<readonly [string, number]> = [
    ["", 0],
    ["a", 1],
    ["abcd", 1],
    ["abcde", 2],
    ["You are a friendly tutor.", 7],
    ["x".repeat(4000), 1000],
  ]
  table.forEach(([text, tokens]) => {
    test(`${text.length} characters cost ${tokens}`, () => {
      expect(estimateTokens(text)).toBe(Tokens.make(tokens))
    })
  })

  test("a request costs its system text and each of its messages, each rounded up on its own", () => {
    expect(estimateRequest("", [])).toBe(Tokens.make(0))
    expect(estimateRequest("You are a friendly tutor.", [])).toBe(Tokens.make(7))
    expect(estimateRequest("You are a friendly tutor.", [{ _tag: "User", text: "Hello" }, { _tag: "Assistant", text: "Hi", toolCalls: [] }])).toBe(Tokens.make(7 + 2 + 1))
  })
})

describe("resolving a request", () => {
  const stored = journal(turnStarted(TurnNumber.make(1)), userMessage("Hello"), answer("Hi"), turnEnded(TurnNumber.make(1), { _tag: "Completed" }), userMessage("Again"))
  /** What resolving gave: the texts in order, or the reason and the place it refused. */
  const told = (...messages: ReadonlyArray<number>): ReadonlyArray<string> | string =>
    Result.match(resolveRequest(stored, request(...messages)), {
      onSuccess: (resolved): ReadonlyArray<string> | string => resolved.messages.map(({ seq, message }) => `${seq} ${message._tag} ${message.text}`),
      onFailure: (refusal) => `${refusal.reason} ${refusal.seq}`,
    })

  const table: ReadonlyArray<readonly [string, ReadonlyArray<number>, ReadonlyArray<string> | string]> = [
    ["no pointer", [], []],
    ["every message, in the journal's order", [2, 3, 5], ["2 User Hello", "3 Assistant Hi", "5 User Again"]],
    ["the request's own order is kept", [5, 2], ["5 User Again", "2 User Hello"]],
    ["a place that holds a record with no message", [2, 1], "UnknownMessage 1"],
    ["a place past the journal's end", [2, 9], "UnknownMessage 9"],
    ["a place before the journal's start", [0], "UnknownMessage 0"],
    ["the same place twice", [2, 3, 2], "RepeatedMessage 2"],
  ]
  table.forEach(([name, messages, resolved]) => {
    test(name, () => {
      expect(told(...messages)).toEqual(resolved)
    })
  })

  test("keeps the system text, the estimate and the budget as the request holds them", () => {
    expect(Result.getOrThrow(resolveRequest(stored, request(2)))).toEqual({
      system: "Be brief.",
      messages: [{ seq: Seq.make(2), message: { _tag: "User", text: "Hello" } }],
      estimatedTokens: Tokens.make(7),
      budgetTokens: Tokens.make(100),
    })
  })

  test("is the inverse of storing it: a request stored as `plugin.loop.request.sent` resolves to the messages it was built from", () => {
    const built = { messages: [Seq.make(2), Seq.make(3), Seq.make(5)], estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000) }
    const [sent] = journal(requestSent(firstStep, "Be brief.", built))
    const read = Option.flatMap(Option.fromNullishOr(sent), (event) => dataOf(requestSentEvent, event))
    expect(read).toEqual(Option.some({ step: firstStep, system: "Be brief.", ...built }))
    // What is stored holds places, never a message's text.
    expect(JSON.stringify(sent)).not.toContain("Hello")
    expect(Option.map(read, (data) => Result.getOrThrow(resolveRequest(stored, data)).messages.map(({ message }) => message.text))).toEqual(Option.some(["Hello", "Hi", "Again"]))
  })
})

describe("the message a turn answers", () => {
  test("is the journal's last user message, and none before there is one", () => {
    expect(turnMessageOf(journal(turnStarted(TurnNumber.make(1))))).toEqual(Option.none())
    expect(turnMessageOf(journal(turnStarted(TurnNumber.make(1)), userMessage("Hello"), answer("Hi"), userMessage("Again"), answer("Yes")))).toEqual(Option.some(Seq.make(4)))
  })
})

describe("inspecting a session", () => {
  const header: SessionHeader = { id: SessionId.make("s-1"), owner: Owner.make("learner"), format: JOURNAL_FORMAT }
  const built = (...messages: ReadonlyArray<number>) => ({ messages: messages.map((seq) => Seq.make(seq)), estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000) })

  test("gives the state the journal folds to and every request it sent, resolved", () => {
    const events = journal(
      turnStarted(TurnNumber.make(1)), userMessage("Hello"), requestSent(firstStep, "Be brief.", built(2)), answer("Hi"), turnEnded(TurnNumber.make(1), { _tag: "Completed" }),
      turnStarted(TurnNumber.make(2)), userMessage("Again"), requestSent(firstStep, "Be brief.", built(2, 4, 7)),
    )
    const inspection = Result.getOrThrow(inspectionOf({ header, events }))
    expect(inspection.state).toEqual({ _tag: "TurnOpen", turn: TurnNumber.make(2) })
    expect(inspection.events).toEqual(events)
    expect(inspection.requests.map((sent) => [sent.seq, sent.step, sent.system, sent.messages.map(({ message }) => message.text)])).toEqual([
      [Seq.make(3), firstStep, "Be brief.", ["Hello"]],
      [Seq.make(8), firstStep, "Be brief.", ["Hello", "Hi", "Again"]],
    ])
  })

  test("refuses a journal whose stored request points at no message", () => {
    const events = journal(turnStarted(TurnNumber.make(1)), userMessage("Hello"), requestSent(firstStep, "Be brief.", built(1)))
    expect(Result.isFailure(inspectionOf({ header, events }))).toBe(true)
  })
})
