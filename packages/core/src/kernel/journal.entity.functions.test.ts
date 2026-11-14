import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { stored, storedEvent, taggedWith } from "./event.entity.functions.js"
import { assistantMessageEvent, CONVERSATION_VOCABULARY, userMessageEvent } from "./conversation.entity.js"
import { assistantMessage, userMessage } from "./conversation.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { EventName, Seq, TurnNumber } from "./ids.entity.js"
import { messageOf, readJournal, vocabularyOf } from "./journal.entity.functions.js"
import { turnEnded, turnStarted } from "./vocabulary.entity.functions.js"
import { KERNEL_VOCABULARY } from "./vocabulary.entity.js"

const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, turn: TurnNumber.make(1), ...draft }))
const record = (plugin: string, event: string, skippable: boolean) => stored(storedEvent(plugin, event, { tags: ["trace"], data: Schema.Struct({}), skippable }), {})
/** A record under core's prefix that this release does not know: one a later core may write. */
const future = (skippable: boolean): StoredDraft =>
  stored({ ...storedEvent("any", "future", { tags: ["trace"], data: Schema.Struct({}), skippable }), name: EventName.make("core.session.future") }, {})
const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({}), skippable: true })

/** What a vocabulary read of a journal: the places it kept, or the record it refused. */
const read = (vocabulary: Parameters<typeof readJournal>[0], ...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<number> | string =>
  Result.match(readJournal(vocabulary)(journal(...drafts)), {
    onSuccess: (kept): ReadonlyArray<number> | string => kept.map((event) => event.seq),
    onFailure: (refusal) => `${refusal._tag} ${refusal.name} at ${refusal.seq}`,
  })

describe("reading a journal", () => {
  const notes = vocabularyOf("notes", [noted])
  const start = turnStarted(TurnNumber.make(1))
  const end = turnEnded(TurnNumber.make(1), { _tag: "Completed" })

  const table: ReadonlyArray<readonly [string, Parameters<typeof readJournal>[0], ReadonlyArray<StoredDraft>, ReadonlyArray<number> | string]> = [
    ["an empty journal", KERNEL_VOCABULARY, [], []],
    ["the session's records every vocabulary knows", KERNEL_VOCABULARY, [start, end], [1, 2]],
    ["an unknown core record that may be skipped", KERNEL_VOCABULARY, [start, future(true), end], [1, 3]],
    ["an unknown core record that may not be skipped", KERNEL_VOCABULARY, [start, future(false)], "UnknownRecord core.session.future at 2"],
    ["a plugin's record is not core's vocabulary's to judge", KERNEL_VOCABULARY, [start, record("notes", "future", false), record("elsewhere", "noted", false)], [1]],
    ["a plugin's vocabulary knows its own definitions", notes, [start, stored(noted, {}), end], [1, 2, 3]],
    ["a plugin's vocabulary skips an unknown record of its own that may be skipped", notes, [start, record("notes", "future", true)], [1]],
    ["a plugin's vocabulary refuses an unknown record of its own that may not be skipped", notes, [start, record("notes", "future", false)], "UnknownRecord plugin.notes.future at 2"],
    ["a plugin's vocabulary still answers for core's records", notes, [future(false)], "UnknownRecord core.session.future at 1"],
    ["a plugin's vocabulary passes over a third plugin's record, whatever it says", notes, [start, record("elsewhere", "noted", false)], [1]],
    ["a prefix is a whole name: `plugin.notes-two.` is not the notes plugin's", notes, [record("notes-two", "noted", false)], []],
  ]

  table.forEach(([name, vocabulary, drafts, kept]) => {
    test(name, () => {
      expect(read(vocabulary, ...drafts)).toEqual(kept)
    })
  })

  test("core's vocabulary answers for `core.` alone; a plugin's adds its own prefix, over core's or over the one it extends", () => {
    expect(KERNEL_VOCABULARY.reads).toEqual(["core."])
    expect(KERNEL_VOCABULARY.knows.map(String)).toEqual(["core.session.turn.started", "core.session.turn.ended"])
    expect(notes.reads).toEqual(["core.", "plugin.notes."])
    expect(notes.knows).toEqual([...KERNEL_VOCABULARY.knows, noted.name])
    const over = vocabularyOf("margin", [], notes)
    expect(over.reads).toEqual(["core.", "plugin.notes.", "plugin.margin."])
    expect(read(over, start, record("notes", "future", false))).toEqual("UnknownRecord plugin.notes.future at 2")
  })
})

describe("the message a record bears", () => {
  /** A plugin's own record of the conversation: a summary that stands for earlier turns, say. */
  const summarised = storedEvent("notes", "summarised", { tags: ["conversation", "memory"], data: Schema.Struct({}), skippable: true })

  test("is read from any record of the conversation, whichever definition it is of", () => {
    const [said, answered, summary, started] = journal(
      userMessage("Hello"),
      assistantMessage("Hi."),
      stored(summarised, {}, { message: { _tag: "Assistant", text: "Summary.", toolCalls: [] } }),
      turnStarted(TurnNumber.make(1)),
    )
    const textOf = (event: StoredEvent | undefined) => Option.map(Option.flatMap(Option.fromNullishOr(event), messageOf), (message) => ("text" in message ? message.text : ""))
    expect(textOf(said)).toEqual(Option.some("Hello"))
    expect(textOf(answered)).toEqual(Option.some("Hi."))
    expect(textOf(summary)).toEqual(Option.some("Summary."))
    expect(textOf(started)).toEqual(Option.none())
    // The data of a message-bearing record holds no copy of the text.
    expect(JSON.stringify(said?.data)).toBe("{}")
  })

  test("is never read from a record of another use, whatever text it bears", () => {
    const [drawn] = journal(stored(noted, {}, { message: { _tag: "User", text: "a label a client draws" } }))
    expect(Option.flatMap(Option.fromNullishOr(drawn), messageOf)).toEqual(Option.none())
  })

  test("the conversation's records are tagged conversation, and its vocabulary knows them", () => {
    expect([userMessageEvent, assistantMessageEvent].map((definition) => `${definition.name} ${definition.tags.join(",")}`)).toEqual([
      "conversation.user.message conversation",
      "conversation.assistant.message conversation",
    ])
    expect(read(CONVERSATION_VOCABULARY, turnStarted(TurnNumber.make(1)), userMessage("Hello"), assistantMessage("Hi."), record("notes", "noted", false))).toEqual([1, 2, 3])
    expect(taggedWith("conversation")({ tags: userMessageEvent.tags })).toBe(true)
    expect(taggedWith("conversation")({ tags: noted.tags })).toBe(false)
  })

  test("an answer's metadata is its data, and the message is the record's", () => {
    const answer = assistantMessage("Hi.", { model: "echo", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 8 } })
    expect(answer.data).toEqual({ model: "echo", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 8 } })
    expect(answer.message).toEqual({ _tag: "Assistant", text: "Hi.", toolCalls: [] })
  })
})
