import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import fc from "fast-check"
import { ConversationId } from "../domain/message.entity.js"
import { EntryId, LogEntry } from "../memory/memory-log.entity.js"
import type { LogBody } from "../memory/memory-log.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import type { TurnEvent } from "../turn/turn-event.entity.js"
import { draftOfEntry, draftOfTurnEvent, entriesOfEvents, turnStartedDraft } from "./session-event.entity.functions.js"
import { MEMORY_KINDS, RESERVED_KINDS } from "./session-event.entity.js"
import type { SessionDraft, SessionLogEvent } from "./session-log.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-00000000e3e3")
const goldenPath = `${import.meta.dir}/../../../sdk/golden/agent-turn.model.json`

/** Every object's keys in another order, all the way down: what a JSON store may hand back. */
const reordered = (value: unknown, order: (keys: ReadonlyArray<string>) => ReadonlyArray<string>): unknown =>
  Array.isArray(value) ? value.map((item) => reordered(item, order))
    : typeof value === "object" && value !== null
      ? Object.fromEntries(order(Object.keys(value)).map((key) => [key, reordered((value as Record<string, unknown>)[key], order)]))
      : value

/** The golden conversation's memory log, stored the way a turn stores it: TurnStarted as the turn's own `turn.started`. */
const storedDrafts = (entries: ReadonlyArray<LogEntry>) => Effect.forEach(entries, (entry): Effect.Effect<Option.Option<SessionDraft>, Schema.SchemaError> =>
  entry.body._tag === "TurnStarted"
    ? turnStartedDraft(entry.turn, {
      runId: entry.runId, key: entry.runId, origin: "user", userMessage: entry.body.userMessage, command: {}, claimed: [], entry: entry.id, at: entry.at,
    }).pipe(Effect.map(Option.some))
    : draftOfEntry(entry)).pipe(Effect.map((drafts) => drafts.flatMap(Option.toArray)))

const asEvents = (drafts: ReadonlyArray<SessionDraft>, order: (keys: ReadonlyArray<string>) => ReadonlyArray<string>): ReadonlyArray<SessionLogEvent> =>
  drafts.map((draft, index) => ({
    session, seq: index + 1, turn: draft.turn, kind: draft.kind, at: 0,
    data: reordered(JSON.parse(JSON.stringify(draft.data)), order) as Record<string, unknown>,
  }))

describe("the memory log stored as session events", () => {
  test("the golden log reads back byte for byte, whatever key order the store keeps", async () => {
    const golden = await Bun.file(goldenPath).json()
    const entries = Schema.decodeUnknownSync(Schema.Array(LogEntry))(golden.log)
    const drafts = await Effect.runPromise(storedDrafts(entries))
    expect(drafts.every((draft) => MEMORY_KINDS.includes(draft.kind))).toBe(true)
    const expected = JSON.stringify(golden.log)
    const orders: ReadonlyArray<(keys: ReadonlyArray<string>) => ReadonlyArray<string>> = [
      (keys) => keys,
      (keys) => [...keys].reverse(),
      (keys) => [...keys].sort(),
    ]
    await Effect.runPromise(Effect.forEach(orders, (order) => entriesOfEvents(asEvents(drafts, order)).pipe(
      Effect.map((back) => expect(JSON.stringify(Schema.encodeSync(Schema.Array(LogEntry))(back))).toBe(expected)),
    )))
  })

  test("any shuffle of the keys reads back the same log", async () => {
    const golden = await Bun.file(goldenPath).json()
    const entries = Schema.decodeUnknownSync(Schema.Array(LogEntry))(golden.log)
    const drafts = await Effect.runPromise(storedDrafts(entries))
    const expected = JSON.stringify(golden.log)
    fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (seed) => {
      const shuffle = (keys: ReadonlyArray<string>) => [...keys].map((key, index) => [key, (seed * (index + 7919)) % 104_729] as const)
        .sort((left, right) => left[1] - right[1]).map(([key]) => key)
      const back = Effect.runSync(entriesOfEvents(asEvents(drafts, shuffle)))
      return JSON.stringify(Schema.encodeSync(Schema.Array(LogEntry))(back)) === expected
    }), { numRuns: 50 })
  })

  test("every compaction, a digest on compaction and a user-role message read back unchanged", async () => {
    const id = (n: number) => EntryId.make(`run-9:${n}`)
    const entry = (n: number, turn: number, body: LogBody): LogEntry => ({ id: id(n), runId: "run-9", turn, step: n % 3, at: 1_000 + n, body })
    const entries: ReadonlyArray<LogEntry> = [
      entry(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "keep { \"z\": 1, \"a\": 2 } verbatim" }) }),
      entry(1, 1, { _tag: "Message", message: { role: "user", content: "a corrective nudge" } }),
      entry(2, 1, { _tag: "Compaction", strategy: "window", version: "2", action: { _tag: "Spill", entry: id(9), preview: "call recall_context" } }),
      entry(3, 1, { _tag: "Compaction", strategy: "window", version: "2", action: { _tag: "DropTurns", throughTurn: 3, ledger: "Earlier:" } }),
      entry(4, 1, { _tag: "Compaction", strategy: "summary", version: "1", action: { _tag: "Summarize", keepFromTurn: 4, summary: "so far" } }),
      entry(5, 1, { _tag: "ToolDigest", entry: id(9), version: "1", mode: "summarize", keep: [], text: "digest", digester: "d@1", trigger: "compaction" }),
      entry(6, 1, { _tag: "TurnEnded", outcome: "failed", reply: Option.none() }),
    ]
    const drafts = await Effect.runPromise(storedDrafts(entries))
    const back = await Effect.runPromise(entriesOfEvents(asEvents(drafts, (keys) => [...keys].reverse())))
    expect(JSON.stringify(Schema.encodeSync(Schema.Array(LogEntry))(back))).toBe(JSON.stringify(Schema.encodeSync(Schema.Array(LogEntry))(entries)))
  })

  test("events that are not memory are not entries", async () => {
    const back = await Effect.runPromise(entriesOfEvents([
      { session, seq: 1, turn: Option.some(1), kind: "step.started", at: 0, data: { step: 0, planned: false, activeTools: [] } },
      { session, seq: 2, turn: Option.some(1), kind: "answer.published", at: 0, data: { text: "a host record" } },
    ]))
    expect(back).toEqual([])
  })
})

describe("the turn's bus events as stored", () => {
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0 }
  test("an assistant message keeps only its step, model and usage; memory holds the content", () => {
    const event: TurnEvent = { _tag: "assistant.message", step: 1, text: "hello", reasoning: "", model: Option.some("m"), toolCalls: [], usage }
    const stored = draftOfTurnEvent(3, event)
    expect(Option.map(stored, (draft) => [draft.kind, Option.getOrNull(draft.turn), draft.data])).toEqual(Option.some(["step.usage", 3, { step: 1, model: "m", usage }]))
  })
  test("a completed tool drops its input and result; transient and duplicated events are not stored", () => {
    const completed: TurnEvent = {
      _tag: "tool.completed", step: 0, invocationId: "i", tool: "lookup", input: { q: 1 }, ok: true, result: { r: 1 }, encoded: { r: 1 },
      durationMs: 5, labels: {}, stage: Option.none(),
    }
    const stored = Option.getOrThrow(draftOfTurnEvent(1, completed))
    expect(Object.keys(stored.data).sort()).toEqual(["durationMs", "invocationId", "labels", "ok", "stage", "step", "tool"])
    const skipped: ReadonlyArray<TurnEvent> = [
      { _tag: "assistant.delta", step: 0, channel: "text", id: "d", delta: "x" },
      { _tag: "skills.activated", skills: [], tools: [], source: "always" },
      { _tag: "turn.ended", runId: "r", turn: 1, outcome: "completed", reply: Option.none() },
    ]
    expect(skipped.map((event) => draftOfTurnEvent(1, event)).every(Option.isNone)).toBe(true)
  })
  test("a host event keeps its own name; reserved names are the framework's", () => {
    const stored = draftOfTurnEvent(2, { _tag: "host", name: "answer.published", data: { id: "a" } })
    expect(Option.map(stored, (draft) => draft.kind)).toEqual(Option.some("answer.published"))
    expect(RESERVED_KINDS.includes("answer.published")).toBe(false)
    expect(["turn.started", "turn.ended", "memory.message", "step.usage", "inbox.queued"].every((kind) => RESERVED_KINDS.includes(kind))).toBe(true)
  })
})
