import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { stored, storedEvent } from "./event.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { EventName, Seq, TurnNumber } from "./ids.entity.js"
import { messageOf, readJournal, readerFor } from "./journal.entity.functions.js"
import { turnEnded, turnStarted } from "./vocabulary.entity.functions.js"
import { KERNEL_READER } from "./vocabulary.entity.js"

const journal = (...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<StoredEvent> => drafts.map((draft, index) => ({ seq: Seq.make(index + 1), at: 0, ...draft }))
const record = (plugin: string, event: string, skippable: boolean) => stored(storedEvent(plugin, event, { data: Schema.Struct({}), skippable }), {})
/** A record under core's prefix that this release does not know: one a later core may write. */
const future = (skippable: boolean): StoredDraft =>
  stored({ ...storedEvent("any", "future", { data: Schema.Struct({}), skippable }), name: EventName.make("core.session.future") }, {})
const noted = storedEvent("notes", "noted", { data: Schema.Struct({}), skippable: true })

/** What a reader made of a journal: the places it kept, or the record it refused. */
const read = (reader: Parameters<typeof readJournal>[0], ...drafts: ReadonlyArray<StoredDraft>): ReadonlyArray<number> | string =>
  Result.match(readJournal(reader)(journal(...drafts)), {
    onSuccess: (kept): ReadonlyArray<number> | string => kept.map((event) => event.seq),
    onFailure: (refusal) => `${refusal._tag} ${refusal.name} at ${refusal.seq}`,
  })

describe("reading a journal", () => {
  const notes = readerFor("notes", [noted])
  const start = turnStarted(TurnNumber.make(1))
  const end = turnEnded(TurnNumber.make(1), { _tag: "Completed" })

  const table: ReadonlyArray<readonly [string, Parameters<typeof readJournal>[0], ReadonlyArray<StoredDraft>, ReadonlyArray<number> | string]> = [
    ["an empty journal", KERNEL_READER, [], []],
    ["the session's records every reader knows", KERNEL_READER, [start, end], [1, 2]],
    ["an unknown core record that may be skipped", KERNEL_READER, [start, future(true), end], [1, 3]],
    ["an unknown core record that may not be skipped", KERNEL_READER, [start, future(false)], "UnknownRecord core.session.future at 2"],
    ["a plugin's record is not core's reader's to judge", KERNEL_READER, [start, record("notes", "future", false), record("elsewhere", "noted", false)], [1]],
    ["a plugin's reader knows its own definitions", notes, [start, stored(noted, {}), end], [1, 2, 3]],
    ["a plugin's reader skips an unknown record of its own that may be skipped", notes, [start, record("notes", "future", true)], [1]],
    ["a plugin's reader refuses an unknown record of its own that may not be skipped", notes, [start, record("notes", "future", false)], "UnknownRecord plugin.notes.future at 2"],
    ["a plugin's reader still answers for core's records", notes, [future(false)], "UnknownRecord core.session.future at 1"],
    ["a plugin's reader passes over a third plugin's record, whatever it says", notes, [start, record("elsewhere", "noted", false)], [1]],
    ["a prefix is a whole name: `plugin.notes-two.` is not the notes plugin's", notes, [record("notes-two", "noted", false)], []],
  ]

  table.forEach(([name, reader, drafts, kept]) => {
    test(name, () => {
      expect(read(reader, ...drafts)).toEqual(kept)
    })
  })

  test("core's reader answers for `core.` alone; a plugin's adds its own prefix, over core's or over the reader it extends", () => {
    expect(KERNEL_READER.reads).toEqual(["core."])
    expect(KERNEL_READER.knows.map(String)).toEqual(["core.session.turn.started", "core.session.turn.ended"])
    expect(notes.reads).toEqual(["core.", "plugin.notes."])
    expect(notes.knows).toEqual([...KERNEL_READER.knows, noted.name])
    const over = readerFor("margin", [], notes)
    expect(over.reads).toEqual(["core.", "plugin.notes.", "plugin.margin."])
    expect(read(over, start, record("notes", "future", false))).toEqual("UnknownRecord plugin.notes.future at 2")
  })
})

describe("the message a record bears", () => {
  test("is on the envelope, for any record", () => {
    const [said, summary, started] = journal(
      stored(noted, {}, { message: { _tag: "User", text: "Hello" } }),
      stored(noted, {}, { message: { _tag: "Assistant", text: "Summary.", toolCalls: [] }, replaces: { from: Seq.make(1), through: Seq.make(1) } }),
      turnStarted(TurnNumber.make(1)),
    )
    expect(Option.map(Option.flatMap(Option.fromNullishOr(said), messageOf), (message) => message.text)).toEqual(Option.some("Hello"))
    expect(Option.map(Option.flatMap(Option.fromNullishOr(summary), messageOf), (message) => message.text)).toEqual(Option.some("Summary."))
    expect(Option.flatMap(Option.fromNullishOr(started), messageOf)).toEqual(Option.none())
    // The data of a message-bearing record holds no copy of the text.
    expect(JSON.stringify(said?.data)).toBe("{}")
  })
})
