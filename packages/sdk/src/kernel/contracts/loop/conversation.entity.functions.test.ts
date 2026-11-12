import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import {
  dataOf,
  KERNEL_READER,
  messageOf,
  readerFor,
  readJournal,
  Seq,
  SessionId,
  stored,
  StoredDraft,
  storedEvent,
  TurnNumber,
  turnStarted,
} from "@xandreed/core/kernel"
import type { StoredDefinition, StoredEvent } from "@xandreed/core/kernel"
import { firstStep } from "./request.entity.functions.js"
import { Tokens } from "./request.entity.js"
import { assistantDelta, assistantMessage, requestSent, userMessage } from "./conversation.entity.functions.js"
import { assistantDeltaEvent, assistantMessageEvent, LOOP_READER, requestSentEvent, userMessageEvent } from "./conversation.entity.js"

const origin = { id: SessionId.make("s-1"), turn: TurnNumber.make(2) }
const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, ...draft }))

describe("the conversation's events", () => {
  test("are named by the loop contract that defines them, stored but the delta", () => {
    expect([userMessageEvent, requestSentEvent, assistantMessageEvent, assistantDeltaEvent].map((definition) => `${definition.kind} ${definition.name}`)).toEqual([
      "stored plugin.loop.user.message",
      "stored plugin.loop.request.sent",
      "stored plugin.loop.assistant.message",
      "live plugin.loop.assistant.delta",
    ])
  })

  test("each constructor's data reads back through its definition's schema", () => {
    const request = { messages: [Seq.make(2)], estimatedTokens: Tokens.make(9), budgetTokens: Tokens.make(3000) }
    const table: ReadonlyArray<readonly [StoredDefinition<Schema.Json>, StoredDraft, Schema.Json]> = [
      [userMessageEvent, userMessage("Hello"), {}],
      [requestSentEvent, requestSent(firstStep, "Be brief.", request), { step: 1, system: "Be brief.", messages: [2], estimatedTokens: 9, budgetTokens: 3000 }],
      [assistantMessageEvent, assistantMessage(firstStep, { _tag: "Assistant", text: "Hi", toolCalls: [] }), { step: 1 }],
    ]
    table.forEach(([definition, draft, data]) => {
      expect(draft.name).toBe(definition.name)
      expect(draft.skippable).toBe(false)
      expect(dataOf(definition, draft)).toEqual(Option.some(data))
      expect(Schema.is(StoredDraft)(draft)).toBe(true)
    })
    expect(userMessage("Hello").message).toEqual({ _tag: "User", text: "Hello" })
    expect(assistantMessage(firstStep, { _tag: "Assistant", text: "Hi", toolCalls: [] }).message).toEqual({ _tag: "Assistant", text: "Hi", toolCalls: [] })
    expect(assistantDelta(origin, "Hel")).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: assistantDeltaEvent.name, data: { text: "Hel" } })
  })

  test("a message-bearing record's data holds no copy of the text", () => {
    const [asked, answered] = journal(userMessage("Hello"), assistantMessage(firstStep, { _tag: "Assistant", text: "Hi", toolCalls: [] }))
    expect(Option.map(Option.flatMap(Option.fromNullishOr(asked), messageOf), (message) => message.text)).toEqual(Option.some("Hello"))
    expect(Option.map(Option.flatMap(Option.fromNullishOr(answered), messageOf), (message) => message.text)).toEqual(Option.some("Hi"))
    expect(JSON.stringify(asked?.data)).toBe("{}")
    expect(JSON.stringify(answered?.data)).toBe("{\"step\":1}")
  })
})

describe("reading the loop's records", () => {
  const record = (plugin: string, event: string, skippable: boolean) => stored(storedEvent(plugin, event, { data: Schema.Struct({}), skippable }), {})
  const dropped = storedEvent("window", "dropped", { data: Schema.Struct({}), skippable: true })
  const window = readerFor("window", [dropped], LOOP_READER)
  const start = turnStarted(TurnNumber.make(1))

  /** What a reader made of a journal: the places it kept, or the record it refused. */
  const read = (reader: Parameters<typeof readJournal>[0], ...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<number> | string =>
    Result.match(readJournal(reader)(journal(...drafts)), {
      onSuccess: (kept): ReadonlyArray<number> | string => kept.map((event) => event.seq),
      onFailure: (refusal) => `${refusal._tag} ${refusal.name} at ${refusal.seq}`,
    })

  const table: ReadonlyArray<readonly [string, Parameters<typeof readJournal>[0], ReadonlyArray<StoredDraft>, ReadonlyArray<number> | string]> = [
    ["the session and loop records the loop's reader knows", LOOP_READER, [start, userMessage("Hello")], [1, 2]],
    ["an unknown loop record that may be skipped", LOOP_READER, [start, record("loop", "future", true), userMessage("Hello")], [1, 3]],
    ["an unknown loop record that may not be skipped", LOOP_READER, [start, record("loop", "future", false)], "UnknownRecord plugin.loop.future at 2"],
    ["another plugin's record is not the loop reader's to judge", LOOP_READER, [start, record("window", "future", false), record("elsewhere", "noted", false)], [1]],
    ["core's reader passes over the loop's records, whatever they say", KERNEL_READER, [start, userMessage("Hello"), record("loop", "future", false)], [1]],
    ["a memory's reader knows its own definitions and the loop's", window, [start, stored(dropped, {}), userMessage("Hello")], [1, 2, 3]],
    ["a memory's reader skips an unknown record of its own that may be skipped", window, [start, record("window", "future", true)], [1]],
    ["a memory's reader refuses an unknown record of its own that may not be skipped", window, [start, record("window", "future", false)], "UnknownRecord plugin.window.future at 2"],
    ["a memory's reader still answers for the loop's records", window, [record("loop", "future", false)], "UnknownRecord plugin.loop.future at 1"],
  ]

  table.forEach(([name, reader, drafts, kept]) => {
    test(name, () => {
      expect(read(reader, ...drafts)).toEqual(kept)
    })
  })

  test("the loop's reader answers for core's records and the loop's; a memory's adds its own", () => {
    expect(LOOP_READER.reads).toEqual(["core.", "plugin.loop."])
    expect(LOOP_READER.knows).toEqual([...KERNEL_READER.knows, userMessageEvent.name, requestSentEvent.name, assistantMessageEvent.name])
    expect(window.reads).toEqual(["core.", "plugin.loop.", "plugin.window."])
    expect(window.knows).toEqual([...LOOP_READER.knows, dropped.name])
  })
})
