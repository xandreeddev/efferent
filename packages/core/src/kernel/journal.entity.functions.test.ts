import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { stored, storedEvent } from "./event.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { firstStep } from "./ids.entity.functions.js"
import { Seq, TurnNumber } from "./ids.entity.js"
import { messageOf, readJournal, readerFor } from "./journal.entity.functions.js"
import { assistantMessage, turnStarted, userMessage } from "./vocabulary.entity.functions.js"
import { KERNEL_READER } from "./vocabulary.entity.js"

const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, ...draft }))
const record = (plugin: string, event: string, skippable: boolean) => stored(storedEvent(plugin, event, { data: Schema.Struct({}), skippable }), {})
const dropped = storedEvent("window", "dropped", { data: Schema.Struct({}), skippable: true })

/** What a reader made of a journal: the places it kept, or the record it refused. */
const read = (reader: Parameters<typeof readJournal>[0], ...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<number> | string =>
  Result.match(readJournal(reader)(journal(...drafts)), {
    onSuccess: (kept): ReadonlyArray<number> | string => kept.map((event) => event.seq),
    onFailure: (refusal) => `${refusal._tag} ${refusal.name} at ${refusal.seq}`,
  })

describe("reading a journal", () => {
  const window = readerFor("window", [dropped])
  const start = turnStarted(TurnNumber.make(1))

  const table: ReadonlyArray<readonly [string, Parameters<typeof readJournal>[0], ReadonlyArray<StoredDraft>, ReadonlyArray<number> | string]> = [
    ["an empty journal", KERNEL_READER, [], []],
    ["the session and loop records every reader knows", KERNEL_READER, [start, userMessage("Hello")], [1, 2]],
    ["an unknown loop record that may be skipped", KERNEL_READER, [start, record("loop", "future", true), userMessage("Hello")], [1, 3]],
    ["an unknown loop record that may not be skipped", KERNEL_READER, [start, record("loop", "future", false)], "UnknownRecord plugin.loop.future at 2"],
    ["an unknown session record that may not be skipped", KERNEL_READER, [record("session", "future", false)], "UnknownRecord plugin.session.future at 1"],
    ["another plugin's record is not the kernel reader's to judge", KERNEL_READER, [start, record("window", "future", false), record("elsewhere", "noted", false)], [1]],
    ["a plugin's reader knows its own definitions", window, [start, stored(dropped, {}), userMessage("Hello")], [1, 2, 3]],
    ["a plugin's reader skips an unknown record of its own that may be skipped", window, [start, record("window", "future", true)], [1]],
    ["a plugin's reader refuses an unknown record of its own that may not be skipped", window, [start, record("window", "future", false)], "UnknownRecord plugin.window.future at 2"],
    ["a plugin's reader still answers for the session and loop records", window, [record("loop", "future", false)], "UnknownRecord plugin.loop.future at 1"],
    ["a plugin's reader passes over a third plugin's record, whatever it says", window, [start, record("elsewhere", "noted", false)], [1]],
    ["a prefix is a whole name: `plugin.window-two.` is not the window's", window, [record("window-two", "noted", false)], []],
  ]

  table.forEach(([name, reader, drafts, kept]) => {
    test(name, () => {
      expect(read(reader, ...drafts)).toEqual(kept)
    })
  })

  test("a reader's prefixes are the session's, the loop's and its own", () => {
    expect(KERNEL_READER.reads).toEqual(["plugin.session.", "plugin.loop."])
    expect(window.reads).toEqual(["plugin.session.", "plugin.loop.", "plugin.window."])
    expect(window.knows).toEqual([...KERNEL_READER.knows, dropped.name])
  })
})

describe("the message a record bears", () => {
  test("is on the envelope, for any record", () => {
    const [asked, answered, summary, started] = journal(
      userMessage("Hello"),
      assistantMessage(firstStep, { _tag: "Assistant", text: "Hi", toolCalls: [] }),
      stored(dropped, {}, { message: { _tag: "User", text: "Summary." }, replaces: { from: Seq.make(1), through: Seq.make(2) } }),
      turnStarted(TurnNumber.make(1)),
    )
    expect(Option.map(Option.flatMap(Option.fromNullishOr(asked), messageOf), (message) => message.text)).toEqual(Option.some("Hello"))
    expect(Option.map(Option.flatMap(Option.fromNullishOr(answered), messageOf), (message) => message.text)).toEqual(Option.some("Hi"))
    expect(Option.map(Option.flatMap(Option.fromNullishOr(summary), messageOf), (message) => message.text)).toEqual(Option.some("Summary."))
    expect(Option.flatMap(Option.fromNullishOr(started), messageOf)).toEqual(Option.none())
    // The data of a message-bearing record holds no copy of the text.
    expect(JSON.stringify(asked?.data)).toBe("{}")
    expect(JSON.stringify(answered?.data)).toBe("{\"step\":1}")
  })
})
