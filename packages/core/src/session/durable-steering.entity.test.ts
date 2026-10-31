import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { EntryId, LogEntry } from "../memory/memory-log.entity.js"
import { InboxItemId } from "./sessions.entity.js"
import { InboxTakenData, JOURNAL_KINDS, RESERVED_KINDS } from "./session-event.entity.js"
import { draftOfEntry, entriesOfEvents, journalSchemaOf, readStored } from "./session-event.entity.functions.js"

const runId = RunId.make("durable-steering-schema")
const session = ConversationId.make("00000000-0000-4000-8000-000000005520")
const input = InboxItemId.make("queued-steer")
const entry: LogEntry = {
  id: EntryId.make(`${runId}:1`), runId, turn: 1, step: 0, at: 0,
  body: { _tag: "Message", run: RunOrdinal.make(0), inbox: input, message: { role: "user", content: "a durable user steer" } },
}

describe("durable steering stored shapes", () => {
  test("an inbox-marked user message round trips with its exact queued identity and optional legacy fields stay optional", async () => {
    const stored = await Effect.runPromise(draftOfEntry(entry))
    expect(Option.isSome(stored)).toBe(true)
    const draft = Option.getOrThrow(stored)
    const back = await Effect.runPromise(entriesOfEvents([{ ...draft, session, seq: 1, at: 0 }]))
    expect(back).toEqual([entry])
    expect(Schema.decodeUnknownOption(LogEntry)({ ...entry, body: { _tag: "Message", message: { role: "assistant", content: [{ type: "text", text: "old reply" }] } } })._tag).toBe("Some")
  })

  test("an assistant or tool message cannot pretend to be consumed queued user input", () => {
    const assistant = { ...entry, body: { ...entry.body, message: { role: "assistant", content: [{ type: "text", text: "not a user steer" }] } } }
    const tool = { ...entry, body: { ...entry.body, message: { role: "tool", content: [] } } }
    expect(Schema.decodeUnknownOption(LogEntry)(assistant)._tag).toBe("None")
    expect(Schema.decodeUnknownOption(LogEntry)(tool)._tag).toBe("None")
  })

  test("inbox.taken is reserved, decoded by readStored, and carries only references to the input and raw message", async () => {
    expect(JOURNAL_KINDS.indexOf("inbox.taken")).toBeGreaterThan(JOURNAL_KINDS.indexOf("inbox.dropped"))
    expect(RESERVED_KINDS.includes("inbox.taken")).toBe(true)
    expect(Option.isSome(journalSchemaOf("inbox.taken"))).toBe(true)
    const data = await Effect.runPromise(Schema.encodeEffect(InboxTakenData)({ id: input, entry: entry.id }))
    expect(Object.keys(data).toSorted()).toEqual(["entry", "id"])
    const receipts = await Effect.runPromise(readStored("inbox.taken", [{ session, seq: 2, turn: Option.some(1), at: 0, kind: "inbox.taken", data }]))
    expect(receipts.map(({ data }) => data)).toEqual([{ id: input, entry: entry.id }])
    expect(Option.isNone(Schema.decodeUnknownOption(InboxTakenData)({ id: input }))).toBe(true)
  })
})
