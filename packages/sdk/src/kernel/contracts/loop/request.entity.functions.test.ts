import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { dataOf, Seq, turnEnded, TurnNumber, turnStarted } from "@xandreed/core/kernel"
import type { StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { estimateRequest, estimateTokens, firstStep, requestsOf, resolveRequest, turnMessageOf } from "./request.entity.functions.js"
import { Tokens } from "./request.entity.js"
import { assistantMessage, requestSent, userMessage } from "./conversation.entity.functions.js"
import { requestSentEvent } from "./conversation.entity.js"

const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, ...draft }))
const answer = (text: string) => assistantMessage(firstStep, { _tag: "Assistant", text, toolCalls: [] })
const pointers = (...messages: ReadonlyArray<number>) => ({ messages: messages.map((seq) => Seq.make(seq)) })

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
  const told = (messages: ReadonlyArray<number>, before?: number): ReadonlyArray<string> | string =>
    Result.match(resolveRequest(stored, pointers(...messages), before === undefined ? undefined : Seq.make(before)), {
      onSuccess: (resolved): ReadonlyArray<string> | string => resolved.map(({ seq, message }) => `${seq} ${message._tag} ${message.text}`),
      onFailure: (refusal) => `${refusal.reason} ${refusal.seq}`,
    })

  const table: ReadonlyArray<readonly [string, ReadonlyArray<number>, number | undefined, ReadonlyArray<string> | string]> = [
    ["no pointer", [], undefined, []],
    ["every message, in the journal's order", [2, 3, 5], undefined, ["2 User Hello", "3 Assistant Hi", "5 User Again"]],
    ["the request's own order is kept", [5, 2], undefined, ["5 User Again", "2 User Hello"]],
    ["a place that holds a record with no message", [2, 1], undefined, "UnknownMessage 1"],
    ["a place past the journal's end", [2, 9], undefined, "UnknownMessage 9"],
    ["a place before the journal's start", [0], undefined, "UnknownMessage 0"],
    ["the same place twice", [2, 3, 2], undefined, "RepeatedMessage 2"],
    ["a request stored at 4 points at earlier messages", [2, 3], 4, ["2 User Hello", "3 Assistant Hi"]],
    ["a request stored at 4 points at a later message", [2, 5], 4, "LaterMessage 5"],
    ["a request stored at 3 points at its own place", [2, 3], 3, "LaterMessage 3"],
  ]
  table.forEach(([name, messages, before, resolved]) => {
    test(name, () => {
      expect(told(messages, before)).toEqual(resolved)
    })
  })

  test("gives each pointer with the message it points at", () => {
    expect(Result.getOrThrow(resolveRequest(stored, pointers(2)))).toEqual([{ seq: Seq.make(2), message: { _tag: "User", text: "Hello" } }])
  })

  test("is the inverse of storing it: a request stored as `plugin.loop.request.sent` resolves to the messages it was built from", () => {
    const built = { messages: [Seq.make(2), Seq.make(3), Seq.make(5)], estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000) }
    const [sent] = journal(requestSent(firstStep, "Be brief.", built))
    const read = Option.flatMap(Option.fromNullishOr(sent), (event) => dataOf(requestSentEvent, event))
    expect(read).toEqual(Option.some({ step: firstStep, system: "Be brief.", ...built }))
    // What is stored holds places, never a message's text.
    expect(JSON.stringify(sent)).not.toContain("Hello")
    expect(Option.map(read, (data) => Result.getOrThrow(resolveRequest(stored, data)).map(({ message }) => message.text))).toEqual(Option.some(["Hello", "Hi", "Again"]))
  })
})

describe("the message a turn answers", () => {
  test("is the journal's last user message, and none before there is one", () => {
    expect(turnMessageOf(journal(turnStarted(TurnNumber.make(1))))).toEqual(Option.none())
    expect(turnMessageOf(journal(turnStarted(TurnNumber.make(1)), userMessage("Hello"), answer("Hi"), userMessage("Again"), answer("Yes")))).toEqual(Option.some(Seq.make(4)))
  })
})

describe("the requests a session sent", () => {
  const built = (...messages: ReadonlyArray<number>) => ({ messages: messages.map((seq) => Seq.make(seq)), estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000) })

  test("are every request the journal stored, each resolved", () => {
    const events = journal(
      turnStarted(TurnNumber.make(1)), userMessage("Hello"), requestSent(firstStep, "Be brief.", built(2)), answer("Hi"), turnEnded(TurnNumber.make(1), { _tag: "Completed" }),
      turnStarted(TurnNumber.make(2)), userMessage("Again"), requestSent(firstStep, "Be brief.", built(2, 4, 7)),
    )
    expect(Result.getOrThrow(requestsOf(events))).toEqual([
      { seq: Seq.make(3), step: firstStep, system: "Be brief.", estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000), messages: [{ seq: Seq.make(2), message: { _tag: "User", text: "Hello" } }] },
      {
        seq: Seq.make(8),
        step: firstStep,
        system: "Be brief.",
        estimatedTokens: Tokens.make(9),
        budgetTokens: Tokens.make(3000),
        messages: [
          { seq: Seq.make(2), message: { _tag: "User", text: "Hello" } },
          { seq: Seq.make(4), message: { _tag: "Assistant", text: "Hi", toolCalls: [] } },
          { seq: Seq.make(7), message: { _tag: "User", text: "Again" } },
        ],
      },
    ])
  })

  test("refuses a journal whose stored request points at no message, or at a message stored after it", () => {
    const told = (...drafts: ReadonlyArray<StoredDraft>) => Result.match(requestsOf(journal(...drafts)), { onSuccess: () => "inspected", onFailure: (refusal) => `${refusal._tag} ${refusal.reason}` })
    expect(told(turnStarted(TurnNumber.make(1)), userMessage("Hello"), requestSent(firstStep, "Be brief.", built(1)))).toBe("RequestRefused UnknownMessage")
    expect(told(turnStarted(TurnNumber.make(1)), userMessage("Hello"), requestSent(firstStep, "Be brief.", built(2, 4)), answer("Hi"))).toBe("RequestRefused LaterMessage")
  })
})
