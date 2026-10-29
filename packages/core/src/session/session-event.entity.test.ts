import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import fc from "fast-check"
import { ConversationId } from "../domain/message.entity.js"
import { EntryId, LogEntry } from "../memory/memory-log.entity.js"
import type { LogBody } from "../memory/memory-log.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { TransientTurnEvents, TURN_EVENT_NAMES, TurnEvent } from "../turn/turn-event.entity.js"
import { zeroUsage } from "../domain/token-usage.entity.functions.js"
import { mediaFromBase64 } from "../domain/media.entity.functions.js"
import { draftOfEntry, draftOfTurnEvent, entriesOfEvents, journalSchemaOf, readStored, readStoredKeys, StoredData, turnStartedDraft, turnUsageOf } from "./session-event.entity.functions.js"
import { JOURNAL_KINDS, MEMORY_KINDS, RECORDED_ELSEWHERE, RESERVED_KINDS } from "./session-event.entity.js"
import type { JsonObject, SessionDraft, SessionLogEvent } from "./session-log.entity.js"

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
    data: reordered(JSON.parse(JSON.stringify(draft.data)), order) as JsonObject,
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

/** A bus event's stored draft, encoded synchronously (the tests' events all encode). */
const storedOf = (turn: number, event: TurnEvent) => Effect.runSync(draftOfTurnEvent(turn, event))

describe("the turn's bus events as stored", () => {
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  test("an assistant message keeps only its step, model and usage; memory holds the content", () => {
    const event: TurnEvent = { _tag: "assistant.message", step: 1, text: "hello", reasoning: "", model: Option.some("m"), toolCalls: [], usage }
    const stored = storedOf(3, event)
    expect(Option.map(stored, (draft) => [draft.kind, Option.getOrNull(draft.turn), draft.data])).toEqual(Option.some(["step.usage", 3, { step: 1, model: "m", usage }]))
  })
  test("a completed tool drops its input and result; transient and duplicated events are not stored", () => {
    const completed: TurnEvent = {
      _tag: "tool.completed", step: 0, invocationId: "i", tool: "lookup", input: { q: 1 }, ok: true, result: { r: 1 }, encoded: { r: 1 },
      durationMs: 5, labels: {}, stage: Option.none(),
    }
    const stored = Option.getOrThrow(storedOf(1, completed))
    expect(Object.keys(stored.data).sort()).toEqual(["durationMs", "invocationId", "labels", "ok", "stage", "step", "tool"])
    const skipped: ReadonlyArray<TurnEvent> = [
      { _tag: "assistant.delta", step: 0, channel: "text", id: "d", delta: "x" },
      { _tag: "tool.progress", step: 0, invocationId: "i", tool: "build", channel: "stdout", text: "compiling" },
      { _tag: "tool.progress", step: 0, invocationId: "i", tool: "build", channel: "status", text: "3 of 7" },
      { _tag: "skills.activated", skills: [], tools: [], source: "always" },
      { _tag: "turn.ended", runId: "r", turn: 1, outcome: "completed", reply: Option.none(), usage: zeroUsage },
    ]
    expect(skipped.map((event) => storedOf(1, event)).every(Option.isNone)).toBe(true)
  })
  test("a host event keeps its own name; reserved names are the framework's", () => {
    const stored = storedOf(2, { _tag: "host", name: "answer.published", data: { id: "a" } })
    expect(Option.map(stored, (draft) => draft.kind)).toEqual(Option.some("answer.published"))
    expect(RESERVED_KINDS.includes("answer.published")).toBe(false)
    expect(["turn.started", "turn.ended", "memory.message", "step.usage", "inbox.queued"].every((kind) => RESERVED_KINDS.includes(kind))).toBe(true)
  })
  test("a stored event's data is JSON: undefined fields are dropped, a value JSON cannot hold fails with the SchemaError", () => {
    // Host data its type refuses (not JSON), as a host in plain JavaScript can still publish it.
    const host = Option.map(storedOf(2, { _tag: "host", name: "answer.published", data: { id: "a", draft: undefined, nested: { at: undefined, n: 1 } } as never }), (draft) => draft.data)
    const started = Option.map(storedOf(1, { _tag: "tool.started", step: 0, invocationId: "i", tool: "lookup", input: { q: "x", page: undefined }, labels: {}, stage: Option.none() }), (draft) => draft.data.input)
    expect([Option.getOrNull(host), Option.getOrNull(started)]).toStrictEqual([{ id: "a", nested: { n: 1 } }, { q: "x" }])
    const big = Effect.runSync(Effect.result(draftOfTurnEvent(1, { _tag: "host", name: "answer.published", data: { big: 1n } as never })))
    expect(big._tag === "Failure" ? big.failure._tag : "stored").toBe("SchemaError")
  })
  test("an event its schema refuses fails with the SchemaError instead of throwing", () => {
    const fractional: TurnEvent = { _tag: "step.started", step: 1.5, planned: false, activeTools: [] }
    const untrimmed: TurnEvent = { _tag: "completion.evaluated", step: 0, verdict: { complete: false, awaiting: [" work "], facts: {} } }
    const results = [fractional, untrimmed].map((event) => Effect.runSync(Effect.result(draftOfTurnEvent(1, event))))
    expect(results.map((result) => result._tag === "Failure" ? result.failure._tag : "stored")).toEqual(["SchemaError", "SchemaError"])
  })
  test("a refused tool call is stored without its input; a stream fallback whole", () => {
    const refused: TurnEvent = { _tag: "tool.refused", step: 1, invocationId: "run-1:call:3", tool: "archive", input: { id: "secret" }, reason: "forbidden", message: "archive requires records.write" }
    const fallback: TurnEvent = { _tag: "stream.fallback", step: 0, message: "the gateway closed the stream" }
    expect([refused, fallback].map((event) => Option.map(storedOf(4, event), (draft) => [draft.kind, Option.getOrNull(draft.turn), draft.data]))).toEqual([
      Option.some(["tool.refused", 4, { step: 1, invocationId: "run-1:call:3", tool: "archive", reason: "forbidden", message: "archive requires records.write" }]),
      Option.some(["stream.fallback", 4, { step: 0, message: "the gateway closed the stream" }]),
    ])
  })
})

describe("the reserved names", () => {
  const tags = TurnEvent.members.map((member) => member.fields._tag.schema.literal)
  test("TURN_EVENT_NAMES is every bus event's name, once each, in the union's order", () => {
    expect([...TURN_EVENT_NAMES]).toEqual(tags)
    expect(Object.keys(TurnEvent.cases)).toEqual(tags)
    expect(new Set(TURN_EVENT_NAMES).size).toBe(TURN_EVENT_NAMES.length)
    expect(TURN_EVENT_NAMES).toEqual([
      "turn.started", "step.started", "tool.started", "tool.refused", "tool.progress", "tool.completed",
      "step.ended", "completion.evaluated", "skills.activated", "context.built", "decision.recorded",
      "assistant.message", "assistant.delta", "stream.fallback", "turn.ended", "host",
    ])
  })
  test("are the journal's kinds and every bus event's name, each once", () => {
    expect(new Set(RESERVED_KINDS)).toEqual(new Set([...JOURNAL_KINDS, ...TURN_EVENT_NAMES]))
    expect(new Set(RESERVED_KINDS).size).toBe(RESERVED_KINDS.length)
    // Names the journal never stores under their own name are reserved too.
    expect(["assistant.message", "assistant.delta", "tool.progress", "skills.activated", "host", "tool.refused", "stream.fallback"].every((name) => RESERVED_KINDS.includes(name))).toBe(true)
  })
  test("every kind an earlier release reserved is still reserved, in the same order", () => {
    const reserved013 = [
      "turn.started", "memory.system", "memory.section", "memory.step", "memory.message", "memory.tool-result", "memory.digest", "memory.skills",
      "memory.compaction", "turn.reply", "step.started", "step.ended", "step.usage", "tool.started", "tool.completed", "completion.evaluated",
      "context.built", "decision.recorded", "request.prepared", "turn.ended", "inbox.queued", "inbox.dropped",
    ]
    expect(RESERVED_KINDS.filter((kind) => reserved013.includes(kind))).toEqual(reserved013)
  })
})

describe("the journal's schemas", () => {
  const decodes = (kind: string, data: unknown) => Option.match(journalSchemaOf(kind), {
    onNone: () => false,
    onSome: (schema) => Option.isSome(Schema.decodeUnknownOption(schema)(data)),
  })
  test("every journal kind has one; a host's or a plugin's own kind, and a bus name never stored as itself, has none", () => {
    expect(JOURNAL_KINDS.filter((kind) => Option.isNone(journalSchemaOf(kind)))).toEqual([])
    expect(["answer.published", "task.started", "tool.progress", "assistant.message", "assistant.delta", "skills.activated", "host"].map(journalSchemaOf).every(Option.isNone)).toBe(true)
    // A reserved name without a schema is a bus event's name the journal does not store as itself.
    expect(RESERVED_KINDS.filter((kind) => Option.isNone(journalSchemaOf(kind))).every((kind) => TURN_EVENT_NAMES.some((name) => name === kind))).toBe(true)
  })
  test("every bus event the journal stores under a kind of its own is stored under a reserved kind, and only those have a schema", () => {
    const tags = TurnEvent.members.map((member) => member.fields._tag.schema.literal)
    const stored = tags.filter((tag) => tag !== "host" && !TransientTurnEvents.includes(tag) && !RECORDED_ELSEWHERE.has(tag))
    const kinds = stored.map((tag) => tag === "assistant.message" ? "step.usage" : tag)
    expect(kinds.filter((kind) => !RESERVED_KINDS.includes(kind) || Option.isNone(journalSchemaOf(kind)))).toEqual([])
    // A bus event's own name has a schema only when it is a reserved kind.
    expect(tags.filter((tag) => Option.isSome(journalSchemaOf(tag)) && !RESERVED_KINDS.includes(tag))).toEqual([])
  })
  test("what the bus stores decodes with its kind's schema, and nothing it omits is required", () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const events: ReadonlyArray<TurnEvent> = [
      { _tag: "assistant.message", step: 1, text: "hello", reasoning: "", model: Option.none(), toolCalls: [], usage },
      { _tag: "tool.completed", step: 0, invocationId: "i", tool: "lookup", input: { q: 1 }, ok: true, result: { r: 1 }, encoded: { r: 1 }, durationMs: 5, labels: {}, stage: Option.none() },
      { _tag: "step.started", step: 0, planned: false, activeTools: ["lookup"] },
      { _tag: "tool.refused", step: 0, invocationId: "i", tool: "lookup", input: { q: 1 }, reason: "call-limit", message: "limit" },
      { _tag: "stream.fallback", step: 0, message: "no stream" },
    ]
    const stored = events.flatMap((event) => Option.toArray(storedOf(1, event)))
    expect(stored.map((draft) => [draft.kind, decodes(draft.kind, draft.data)])).toEqual([
      ["step.usage", true], ["tool.completed", true], ["step.started", true], ["tool.refused", true], ["stream.fallback", true],
    ])
  })
  test("a memory entry decodes as its kind's envelope; the inbox records decode as written", async () => {
    const entry: LogEntry = { id: EntryId.make("r:1"), runId: "r", turn: 1, step: 0, at: 5, body: { _tag: "StepContext", step: 0, text: "STEP 0" } }
    const draft = Option.getOrThrow(await Effect.runPromise(draftOfEntry(entry)))
    expect([draft.kind, decodes(draft.kind, draft.data), decodes("memory.message", draft.data)]).toEqual(["memory.step", true, false])
    expect(decodes("inbox.queued", { id: "a", source: {}, content: "hello" })).toBe(true)
    expect(decodes("inbox.dropped", { id: "a", reason: "attempts" })).toBe(true)
    expect(decodes("inbox.dropped", { id: "a" })).toBe(false)
  })
  test("the events recorded elsewhere are not stored from the bus", () => {
    expect([...RECORDED_ELSEWHERE]).toEqual(["turn.started", "turn.ended", "skills.activated"])
    const recordedElsewhere: ReadonlyArray<TurnEvent> = [
      { _tag: "turn.started", runId: "r", turn: 1, userMessage: new UserMessage({ text: "hello" }), meta: {} },
      { _tag: "turn.ended", runId: "r", turn: 1, outcome: "completed", reply: Option.some("hi"), usage: zeroUsage },
      { _tag: "skills.activated", skills: ["s"], tools: ["t"], source: "host" },
    ]
    expect(recordedElsewhere.map((event) => event._tag)).toEqual([...RECORDED_ELSEWHERE])
    expect(recordedElsewhere.map((event) => storedOf(1, event)).every(Option.isNone)).toBe(true)
  })
})

describe("a turn's usage from the stored events", () => {
  const stepUsage = (seq: number, turn: number, data: JsonObject): SessionLogEvent =>
    ({ session, seq, turn: Option.some(turn), kind: "step.usage", at: 0, data })
  const full = (input: number) => ({ inputTokens: input, outputTokens: 20, totalTokens: input + 20, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 5 })

  test("sums only its own turn's step.usage records", async () => {
    const events: ReadonlyArray<SessionLogEvent> = [
      stepUsage(1, 1, { step: 0, model: null, usage: full(100) }),
      stepUsage(2, 2, { step: 0, model: "m", usage: full(200) }),
      { session, seq: 3, turn: Option.some(2), kind: "step.started", at: 0, data: { step: 1, planned: false, activeTools: [] } },
      stepUsage(4, 2, { step: 1, model: "m", usage: full(300) }),
    ]
    expect(await Effect.runPromise(turnUsageOf(events, 2))).toEqual({
      inputTokens: 500, outputTokens: 40, totalTokens: 540, cacheReadTokens: 60, cacheWriteTokens: 20, reasoningTokens: 10,
    })
    expect(await Effect.runPromise(turnUsageOf(events, 3))).toEqual(zeroUsage)
  })

  test("a record written before 0.14.0 reads 0 cache-write and reasoning tokens", async () => {
    const old = stepUsage(1, 1, { step: 0, model: "m", usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107, cacheReadTokens: 90 } })
    expect(await Effect.runPromise(turnUsageOf([old], 1))).toEqual({
      inputTokens: 100, outputTokens: 7, totalTokens: 107, cacheReadTokens: 90, cacheWriteTokens: 0, reasoningTokens: 0,
    })
  })

  test("a step.usage record with a malformed usage fails", async () => {
    const broken = stepUsage(1, 1, { step: 0, model: null, usage: { inputTokens: "many" } })
    expect((await Effect.runPromise(Effect.result(turnUsageOf([broken], 1))))._tag).toBe("Failure")
  })
})

describe("a stored turn.started and its user message", () => {
  const pixel = Effect.runSync(mediaFromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", { name: "pixel.png" }))
  const startedEvent = (data: JsonObject): SessionLogEvent => ({ session, seq: 1, turn: Option.some(1), kind: "turn.started", at: 0, data })
  const fields = { runId: "run-1", key: "k", origin: "user", command: {}, claimed: [], entry: "run-1:0", at: 7 }

  test("one written before 0.14.0 with whitespace-only text still decodes, and is the memory's TurnStarted", async () => {
    const event = startedEvent({ ...fields, userMessage: { text: " " } })
    expect(Option.isSome(Schema.decodeUnknownOption(journalSchemaOf("turn.started").pipe(Option.getOrThrow))(event.data))).toBe(true)
    const [entry] = await Effect.runPromise(entriesOfEvents([event]))
    expect(entry?.body._tag === "TurnStarted" ? entry.body.userMessage.text : "").toBe(" ")
  })

  test("a text-only message is stored as before; one with images stores them and reads back as the memory's entry", async () => {
    const draft = (userMessage: UserMessage) => Effect.runPromise(turnStartedDraft(1, {
      runId: "run-1", key: "k", origin: "user", userMessage, command: {}, claimed: [], entry: EntryId.make("run-1:0"), at: 7,
    }))
    expect((await draft(new UserMessage({ text: "hello" }))).data.userMessage).toEqual({ text: "hello" })
    const withImage = await draft(new UserMessage({ text: "", attachments: [pixel] }))
    expect(withImage.data.userMessage).toEqual({ text: "", attachments: [pixel] })
    const [entry] = await Effect.runPromise(entriesOfEvents([startedEvent(JSON.parse(JSON.stringify(withImage.data)))]))
    expect(entry?.body).toEqual({ _tag: "TurnStarted", userMessage: new UserMessage({ text: "", attachments: [pixel] }) })
  })
})

describe("stored events read by their kind", () => {
  const event = (seq: number, kind: string, data: JsonObject): SessionLogEvent => ({ session, seq, turn: Option.some(1), kind, at: 0, data })
  const started = { runId: "run-1", key: "k", origin: "user", userMessage: { text: "hello" }, command: {}, claimed: [], entry: "run-1:0", at: 7 }
  const header = (runId: string, step: number, system: string): JsonObject => ({
    version: 1, runId, step, strategyVersion: "window@1", system,
    render: { strategy: "window", currentTurn: 1, currentRun: runId, turnContext: "current", replies: true, stepContext: "tail", digests: true, media: { mode: "none", maxImages: 8 } },
    through: null, contextFingerprint: "f", tools: [], toolChoice: "auto", model: null, cacheKey: null, callPolicy: null,
  })
  const failed = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect)).then((result) => result._tag === "Failure")

  test("the kinds read back by their fields are the journal's, with the same schemas", () => {
    expect(Object.keys(StoredData)).toEqual(["turn.started", "turn.ended", "inbox.queued", "inbox.dropped", "step.usage", "request.prepared"])
    expect(Object.entries(StoredData).every(([kind, schema]) => Option.contains(journalSchemaOf(kind), schema))).toBe(true)
  })

  test("only the events of the kind are read, in order, each decoded", async () => {
    const events = [
      event(1, "inbox.queued", { id: "a", source: { kind: "task" }, content: "first" }),
      event(2, "inbox.dropped", { id: "a", reason: "attempts" }),
      event(3, "inbox.queued", { id: "b", source: {}, content: "" }),
    ]
    const queued = await Effect.runPromise(readStored("inbox.queued", events))
    expect(queued.map((stored) => [stored.event.seq, stored.data])).toEqual([
      [1, { id: "a", source: { kind: "task" }, content: "first" }],
      [3, { id: "b", source: {}, content: "" }],
    ])
    const ended = await Effect.runPromise(readStored("turn.ended", [event(4, "turn.ended", { reason: "failed", failure: { code: "turn.defect", message: "boom" } })]))
    expect(ended.map((stored) => stored.data.failure)).toEqual([Option.some({ code: "turn.defect", message: "boom" })])
  })

  test("a row of the kind that does not decode fails the read instead of being skipped or read raw", async () => {
    expect(await failed(readStored("inbox.queued", [event(1, "inbox.queued", { id: "a", source: "a task", content: "x" })]))).toBe(true)
    expect(await failed(readStored("turn.ended", [event(1, "turn.ended", { reason: "gone", failure: null })]))).toBe(true)
    // A row of another kind is not read at all.
    expect(await Effect.runPromise(readStored("turn.ended", [event(1, "inbox.queued", { id: 5 })]))).toEqual([])
  })

  test("a lookup decodes a turn's keys and a request's run and step, never the rest", async () => {
    const broken = { ...started, userMessage: { attachments: "not images" } }
    const starts = [event(1, "turn.started", broken), event(2, "turn.started", { ...started, runId: "run-2", key: "k2", entry: "run-2:0" })]
    // The whole record does not decode; its keys do.
    expect(await failed(readStored("turn.started", starts))).toBe(true)
    const keys = await Effect.runPromise(readStoredKeys("turn.started", starts))
    expect(keys.map((found) => [found.event.seq, found.keys])).toEqual([
      [1, { runId: "run-1", key: "k", entry: EntryId.make("run-1:0") }],
      [2, { runId: "run-2", key: "k2", entry: EntryId.make("run-2:0") }],
    ])
    const headers = await Effect.runPromise(readStoredKeys("request.prepared", [event(3, "request.prepared", { ...header("run-1", 2, "system"), system: 42 })]))
    expect(headers.map((found) => found.keys)).toEqual([{ runId: "run-1", step: 2 }])
    expect(await failed(readStored("request.prepared", headers.map((found) => found.event)))).toBe(true)
    // A key that does not decode fails the lookup.
    expect(await failed(readStoredKeys("turn.started", [event(4, "turn.started", { ...started, key: 7 })]))).toBe(true)
  })

  test("a request header decodes whole: one written before 0.14.0 reads the request's media limit", async () => {
    const [read] = await Effect.runPromise(readStored("request.prepared", [event(1, "request.prepared", header("run-1", 0, "system"))]))
    expect([read?.data.runId, read?.data.step, read?.data.system, read?.data.render.media.maxChars]).toEqual(["run-1", 0, "system", 20_000_000])
  })
})
