import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { Seq, turnEnded, turnStarted, TurnNumber } from "@xandreed/core/kernel"
import type { StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { assistantMessage, firstStep, requestSent, Tokens, userMessage } from "@xandreed/sdk/kernel"
import { DEFAULT_AGENT } from "./lesson1.source.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"
import { loadEcho } from "./models/mock.ts"
import { setField } from "./config-edit.ts"
import { inspectorOf, recordsOf } from "./context-model.ts"
import type { InspectorModel } from "./context-model.ts"
import { LessonRuntime } from "./runtime.ts"

/** A journal written by hand: each draft at the next place. */
const journalOf = (drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ ...draft, seq: Seq.make(index + 1), at: 0 }))
const asked = (text: string) => userMessage(text)
const answered = (text: string) => assistantMessage(firstStep, { _tag: "Assistant", text, toolCalls: [] })
const sent = (system: string, messages: ReadonlyArray<number>, estimated: number, budget = 400) =>
  requestSent(firstStep, system, { messages: messages.map((seq) => Seq.make(seq)), estimatedTokens: Tokens.make(estimated), budgetTokens: Tokens.make(budget) })
const opened = (turn: number) => turnStarted(TurnNumber.make(turn))
const closed = (turn: number, outcome: "Completed" | "Interrupted" = "Completed") => turnEnded(TurnNumber.make(turn), outcome === "Completed" ? { _tag: "Completed" } : { _tag: "Interrupted" })
const model = (events: ReadonlyArray<StoredEvent>): InspectorModel => Result.getOrThrow(inspectorOf(events))

describe("inspectorOf, over a hand-written journal", () => {
  // Turn 1: "one" → "r1". Turn 2: "two", sent with turn 1 → "r2". Turn 3: "three", sent alone → "r3".
  const events = journalOf([
    opened(1), asked("one"), sent("sys", [2], 2), answered("r1"), closed(1),
    opened(2), asked("two"), sent("sys", [2, 4, 7], 3), answered("r2"), closed(2),
    opened(3), asked("three"), sent("sys", [12], 3), answered("r3"), closed(3),
  ])
  const inspected = model(events)

  test("each record gets the turn that the last turn start before it opened", () => {
    expect(recordsOf(events).map((record) => Option.getOrNull(record.turn))).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3])
  })

  test("a request's stack is the system text, then what it points at; its own turn's message is the current one", () => {
    expect(inspected.requests[1]?.layers.map((layer) => [layer.kind, layer.role, layer.text])).toEqual([
      ["system", "system", "sys"], ["past", "user", "one"], ["past", "assistant", "r1"], ["current", "user", "two"],
    ])
    // Each layer is the kernel's estimate of its text; together they are the request's estimate.
    expect(inspected.requests[1]?.layers.map((layer) => layer.tokens)).toEqual([1, 1, 1, 1])
  })

  test("shown and dropped come from the request's pointers, so any memory is drawn right", () => {
    const statusIn = (index: number) => inspected.requests[index]?.entries.map((view) => `${view.entry.turn}${view.entry.role[0]}:${view.status}`)
    expect(statusIn(1)).toEqual(["1y:shown", "1a:shown", "2y:current", "2a:reply"])
    expect(statusIn(2)).toEqual(["1y:dropped", "1a:dropped", "2y:dropped", "2a:dropped", "3y:current", "3a:reply"])
  })

  test("the reusable prefix is what consecutive requests share from the start, and none when the start moves", () => {
    expect(Option.isNone(inspected.requests[0]!.prefix)).toBe(true)
    expect(inspected.requests[1]?.layers.map((layer) => layer.reusable)).toEqual([true, true, false, false])
    expect(Option.getOrThrow(inspected.requests[1]!.prefix)).toEqual({ layers: 2, tokens: 2, of: 4 })
    expect(Option.getOrThrow(inspected.requests[2]!.prefix)).toEqual({ layers: 1, tokens: 1, of: 3 })
  })

  test("a changed system text makes nothing reusable", () => {
    const changed = model(journalOf([
      opened(1), asked("one"), sent("sys", [2], 2), answered("r1"), closed(1),
      opened(2), asked("two"), sent("pirate", [2, 4, 7], 4), answered("r2"), closed(2),
    ]))
    expect(Option.getOrThrow(changed.requests[1]!.prefix)).toEqual({ layers: 0, tokens: 0, of: 5 })
    expect(changed.requests[1]?.layers.every((layer) => !layer.reusable)).toBe(true)
  })

  test("a turn that did not complete is marked on its entries, and later requests may still carry its message", () => {
    const stopped = model(journalOf([
      opened(1), asked("one"), sent("sys", [2], 2), closed(1, "Interrupted"),
      opened(2), asked("two"), sent("sys", [2, 6], 2), answered("r2"), closed(2),
    ]))
    expect(stopped.requests[1]?.entries.map((view) => [view.entry.text, view.status, Option.getOrNull(view.ended)])).toEqual([
      ["one", "shown", "Interrupted"], ["two", "current", null], ["r2", "reply", null],
    ])
  })

  test("the last turn's figures: steps sent, the estimate of its request, and of its answer", () => {
    expect(Option.getOrThrow(inspected.last)).toEqual({ turn: 3, steps: 1, sentTokens: 3, answeredTokens: 1 })
  })

  test("a request that points at nothing refuses the journal, and the refusal comes back", () => {
    const refused = inspectorOf(journalOf([opened(1), asked("one"), sent("sys", [9], 2)]))
    expect(Result.isFailure(refused) && refused.failure._tag).toBe("RequestRefused")
  })
})

describe("inspectorOf, over a session the lesson runtime recorded", () => {
  const FILL = ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4", "tell me about topic 5"]
  const recorded = async (steps: (runtime: LessonRuntime) => Promise<void>) => {
    const runtime = await LessonRuntime.create()
    runtime.setModel(loadEcho())
    await runtime.rebuild(DEFAULT_AGENT, DEFAULT_TINY)
    await steps(runtime)
    const journal = await runtime.journal()
    await runtime.dispose()
    return model(journal)
  }
  const sendAll = async (runtime: LessonRuntime, texts: ReadonlyArray<string>) => { await Promise.all((await runtime.send(texts)).map((entry) => entry.outcome)) }

  test("step 6: five messages fit in 3000 tokens, and at a budget of 80 the next request leaves out the three oldest turns", async () => {
    const inspected = await recorded(async (runtime) => {
      await sendAll(runtime, FILL)
      await runtime.rebuild(Option.getOrThrow(setField(DEFAULT_AGENT, "budgetTokens", 80)), DEFAULT_TINY)
      await sendAll(runtime, ["tell me about topic 6"])
    })
    // The figures the lesson's step 6 gives: each Echo turn costs about 24 tokens, the system text 12.
    expect(inspected.requests.map((request) => [request.estimatedTokens, request.budgetTokens])).toEqual([
      [18, 3000], [43, 3000], [67, 3000], [91, 3000], [115, 3000], [66, 80],
    ])
    const last = inspected.requests.at(-1)!
    expect(last.layers.map((layer) => layer.kind)).toEqual(["system", "past", "past", "past", "past", "current"])
    expect(last.entries.filter((view) => view.status === "dropped")).toHaveLength(6)
    expect(inspected.journal.filter((entry) => entry.role === "you")).toHaveLength(6)
    // The window recorded what it dropped, through turn 3's answer.
    expect(inspected.records.filter((record) => record.name === "plugin.window.dropped").map((record) => record.data)).toEqual([{ through: 14 }])
    // Each earlier request extended the one before it: all it held was reusable, all but the last answer and the new message.
    expect(Option.getOrThrow(inspected.requests[4]!.prefix)).toEqual({ layers: 8, tokens: 91, of: 115 })
    // The request after the drop starts elsewhere: only the system text is shared.
    expect(Option.getOrThrow(last.prefix)).toEqual({ layers: 1, tokens: 12, of: 66 })
  }, 30_000)

  test("the learner's memory: the stack holds only the current message, and the journal everything", async () => {
    const inspected = await recorded(async (runtime) => {
      await sendAll(runtime, FILL.slice(0, 2))
      await runtime.rebuild(Option.getOrThrow(setField(DEFAULT_AGENT, "memory", "last")), DEFAULT_TINY)
      await sendAll(runtime, FILL.slice(2, 4))
    })
    expect(inspected.requests.map((request) => request.layers.length)).toEqual([2, 4, 2, 2])
    const last = inspected.requests.at(-1)!
    expect(last.entries.map((view) => view.status)).toEqual(["dropped", "dropped", "dropped", "dropped", "dropped", "dropped", "current", "reply"])
    expect(Option.getOrThrow(last.prefix).layers).toBe(1)
  }, 30_000)

  test("every entry's label agrees with what the request resolved to", async () => {
    const inspected = await recorded(async (runtime) => {
      await runtime.rebuild(Option.getOrThrow(setField(DEFAULT_AGENT, "budgetTokens", 80)), DEFAULT_TINY)
      await sendAll(runtime, [...FILL, "tell me about topic 6"])
    })
    for (const request of inspected.requests) {
      const sentTexts = request.layers.slice(1).map((layer) => layer.text)
      for (const view of request.entries) {
        if (view.status === "shown" || view.status === "current") expect(sentTexts).toContain(view.entry.text)
        if (view.status === "dropped") expect(sentTexts).not.toContain(view.entry.text)
      }
      expect(request.layers.reduce((sum, layer) => sum + layer.tokens, 0)).toBe(request.estimatedTokens)
    }
  }, 30_000)
})
