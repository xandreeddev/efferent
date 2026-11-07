import { Effect, Layer, Match, Option, Schema, Struct } from "effect"
import {
  CommittedTurnObservers, HarnessError, KnowledgeError, KnowledgeJobId, KnowledgeSourceId,
  LongTermMemory, Sessions, ToolCompletedEvent, definePlugin, entriesOfEvents, readStored, toolInputsByResult, userMessageText,
} from "@xandreed/core"
import type { LogEntry, SessionAddress, SessionLogEvent } from "@xandreed/core"
import { MemoryCapture, MemoryCaptureAdmission } from "./ports/memory-capture.port.js"
import { MemoryCaptureAck, MemoryCaptureConfig, MemoryCaptureDecision, memoryCaptureDefaults, type MemorySyncResult } from "./memory.entity.js"

const ACK = "@xandreed/plugin-memory/capture.ack"
const captureKinds = ["turn.started", "memory.message", "memory.tool-result", "tool.completed", "turn.reply", "turn.ended"]
const excluded = new Set(["recall_memory", "read_memory", "remember_memory", "forget_memory", "search_knowledge", "read_knowledge", "recall_context", "load_skill", "read_skill_reference"])
const Receipt = ToolCompletedEvent.mapFields(Struct.pick(["invocationId", "toolCallId", "tool", "ok", "step"]))
type Receipt = typeof Receipt.Type
const storageFailure = (cause: unknown) => new KnowledgeError({ reason: "Unavailable", message: "The committed conversation could not be synchronized", cause })
const corrupt = (cause: unknown) => new KnowledgeError({ reason: "Corrupt", message: "The committed memory capture journal is invalid", cause })

const userText = (message: { readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }> }): string => typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" && part.text !== undefined ? [part.text] : []).join("\n")

/** Deterministic evidence keeps user statements, final replies, and actual tool outcomes separate. */
export const capturedTurnText = (entries: ReadonlyArray<LogEntry>, receipts: ReadonlyArray<Receipt> = []): string => {
  const inputs = toolInputsByResult(entries)
  return [...entries.flatMap((entry) => Match.valueTags(entry.body, {
  TurnStarted: (body) => [`User: ${userMessageText(body.userMessage)}`],
  Message: (body) => body.message.role === "user" && body.inbox !== undefined ? [`User: ${userText(body.message)}`] : [],
  TurnEnded: (body) => Option.match(body.reply, { onNone: () => [], onSome: (reply) => [`Assistant final reply: ${reply}`] }),
  ToolResult: (body) => {
    if (excluded.has(body.toolName)) return []
    return [`Tool result: ${body.toolName}\nPairing key: ${JSON.stringify(body.toolCallId)}\nStep: ${entry.step}\nLoop run: ${body.run ?? "unavailable"}\nRecorded outcome: ${body.isError ? "reported failure" : "returned a result"}\nArguments: ${JSON.stringify(inputs.get(entry.id))}\nRecorded result: ${body.view}`]
  },
  SystemPrepared: () => [], TurnContext: () => [], StepContext: () => [], ToolDigest: () => [], ToolsActivated: () => [], Compaction: () => [], ToolPresentation: () => [],
})), ...receipts.filter((receipt) => !excluded.has(receipt.tool)).map((receipt) =>
  `Tool handler receipt: ${receipt.tool}\nInvocation: ${receipt.invocationId}\nPairing key: ${receipt.toolCallId === undefined ? "unavailable" : JSON.stringify(receipt.toolCallId)}\nStep: ${receipt.step}\nHandler outcome: ${receipt.ok ? "returned a result" : "reported failure"}\nA handler receipt alone does not confirm a real-world effect; inspect the recorded domain result.`,
)].join("\n\n")
}

/** Bounded split keeps all text; each source part remains independently retryable. */
export const splitCapturedEvidence = (text: string, maximum: number): ReadonlyArray<{ readonly text: string; readonly start: number; readonly end: number }> => {
  const parts: Array<{ readonly text: string; readonly start: number; readonly end: number }> = []
  Array.from({ length: Math.ceil(text.length / Math.max(1, maximum - 1)) + 1 }).reduce<number>((start) => {
    if (start >= text.length) return start
    const proposed = Math.min(text.length, start + maximum)
    const end = proposed > start + 1 && /[\uD800-\uDBFF]/u.test(text.charAt(proposed - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(proposed)) ? proposed - 1 : proposed
    parts.push({ text: text.slice(start, end), start, end })
    return end
  }, 0)
  return parts
}

const invalidDecision = (cause: unknown) => new KnowledgeError({ reason: "Invalid", message: "The capture admission returned an invalid decision", cause })

/** Build synchronization over the caller's owner-checked Sessions, independently of engine processing. @public */
export const MemoryCaptureLive = (config: MemoryCaptureConfig) => Layer.effect(MemoryCapture, Effect.gen(function* () {
  const sessions = yield* Sessions
  const memory = yield* LongTermMemory
  const decodedAcks = (events: ReadonlyArray<SessionLogEvent>) => Effect.forEach(events.filter((event) => event.data.namespace === config.namespace && event.data.collection === config.collection), (event) =>
    Schema.decodeUnknownEffect(MemoryCaptureAck)(event.data).pipe(Effect.mapError(corrupt), Effect.flatMap((ack) => ack.through < event.seq
      ? Effect.succeed(ack.through) : Effect.fail(corrupt("A checkpoint points beyond its publication")))), { concurrency: 1 })
  const checkpoint = (address: SessionAddress): Effect.Effect<number, KnowledgeError> => Effect.gen(function* () {
    const view = yield* sessions.get(address).pipe(Effect.mapError(storageFailure))
    const recent = yield* sessions.read(address, { after: Math.max(0, view.seq - config.pageSize), kinds: [ACK], limit: config.pageSize }).pipe(Effect.mapError(storageFailure), Effect.flatMap(decodedAcks))
    if (recent.length > 0) return recent.reduce((through, value) => Math.max(through, value), 0)
    const scan = (after: number, pages: number, through: number): Effect.Effect<number, KnowledgeError> => Effect.gen(function* () {
      const events = yield* sessions.read(address, { after, kinds: [ACK], limit: config.pageSize }).pipe(Effect.mapError(storageFailure))
      const decoded = yield* decodedAcks(events)
      const next = decoded.reduce((maximum, value) => Math.max(maximum, value), through)
      if (events.length < config.pageSize) return next
      const cursor = events.at(-1)?.seq ?? after
      if (pages >= config.maxPages) {
        const more = yield* sessions.read(address, { after: cursor, kinds: [ACK], limit: 1 }).pipe(Effect.mapError(storageFailure))
        return more.length === 0 ? next : yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Increase the capture page limit to locate the durable checkpoint" }))
      }
      return yield* scan(cursor, pages + 1, next)
    })
    return yield* scan(0, 1, 0)
  })
  const read = (address: SessionAddress, after: number, events: ReadonlyArray<SessionLogEvent>, pages: number): Effect.Effect<{ readonly events: ReadonlyArray<SessionLogEvent>; readonly limited: boolean }, KnowledgeError> => Effect.gen(function* () {
    const page = yield* sessions.read(address, { after, kinds: captureKinds, limit: config.pageSize }).pipe(Effect.mapError(storageFailure))
    const combined = [...events, ...page]
    if (page.length < config.pageSize || combined.filter((event) => event.kind === "turn.ended").length >= config.maxTurns) return { events: combined, limited: false }
    if (pages >= config.maxPages) return { events: combined, limited: true }
    return yield* read(address, page.at(-1)?.seq ?? after, combined, pages + 1)
  })
  const sync: (address: SessionAddress) => Effect.Effect<MemorySyncResult, KnowledgeError> = Effect.fn("memory.capture.sync")(function* (address: SessionAddress) {
    const admission = yield* MemoryCaptureAdmission
    const after = yield* checkpoint(address)
    const scanned = yield* read(address, after, [], 1)
    const events = scanned.events
    const beyond = scanned.limited ? yield* sessions.read(address, { after: events.at(-1)?.seq ?? after, kinds: captureKinds, limit: 1 }).pipe(Effect.mapError(storageFailure)) : []
    const limited = scanned.limited && beyond.length > 0
    const endings = events.filter((event) => event.kind === "turn.ended").slice(0, config.maxTurns)
    if (endings.length === 0) return { sources: 0, through: after, hasMore: events.length > 0,
      ...(events.length === 0 ? {} : { stalled: limited ? "page-limit" as const : "open-turn" as const }),
    }
    const synced = yield* Effect.forEach(endings, (ending) => Effect.gen(function* () {
      if (Option.isNone(ending.turn) || ending.turn.value < 1) return yield* Effect.fail(corrupt("A closing record has no turn number"))
      const turn = ending.turn.value
      const turnEvents = events.filter((event) => event.seq <= ending.seq && Option.isSome(event.turn) && Option.contains(ending.turn, event.turn.value))
      const starts = yield* readStored("turn.started", turnEvents).pipe(Effect.mapError(corrupt))
      const started = starts[0]
      if (started === undefined) return yield* Effect.fail(new KnowledgeError({ reason: "Corrupt", message: "A committed turn has no starting evidence" }))
      const entries = yield* entriesOfEvents(turnEvents).pipe(Effect.mapError(corrupt))
      const receipts = yield* Effect.forEach(turnEvents.filter((event) => event.kind === "tool.completed"), (event) => Schema.decodeUnknownEffect(Receipt)(event.data).pipe(Effect.mapError(corrupt)), { concurrency: 1 })
      const captured = capturedTurnText(entries, receipts)
      const decision = yield* admission.admit({ session: { owner: address.owner, id: address.id }, runId: started.data.runId, turn, text: captured, entries }).pipe(
        Effect.flatMap((value) => Schema.decodeUnknownEffect(MemoryCaptureDecision)(value).pipe(Effect.mapError(invalidDecision))),
      )
      // A refused turn has no evidence, so it enqueues nothing; its checkpoint below still moves past it.
      const { evidence, refused } = MemoryCaptureDecision.match(decision, {
        Admit: (admit) => ({ evidence: admit.text ?? captured, refused: [] }),
        Refuse: () => ({ evidence: "", refused: [turn] }),
      })
      const parts = splitCapturedEvidence(evidence, config.maxSourceChars)
      const episode = `conversation:${address.id}:${started.data.runId}`
      yield* Effect.forEach(parts, (part, index) => {
        const key = `${episode}:1:${index}`
        return memory.capture({
          jobId: KnowledgeJobId.make(key), engine: "memory:1", expectedRevision: Option.none(),
          source: {
            scope: { owner: address.owner, namespace: config.namespace, collection: config.collection },
            ref: { id: KnowledgeSourceId.make(key), revision: 1 }, text: part.text,
            occurredAt: started.event.at, recordedAt: ending.at,
            metadata: { kind: "conversation", episode, session: address.id, run: started.data.runId, turn, through: ending.seq, part: index, offset: part.start, end: part.end, totalChars: evidence.length },
          },
        }).pipe(Effect.catchIf((error) => error.reason === "Tombstoned", () => Effect.succeed(undefined)))
      }, { concurrency: 1 })
      const through = ending.seq
      yield* sessions.transact(address, () => checkpoint(address).pipe(Effect.map((current) => ({
        drafts: current >= through ? [] : [{ kind: ACK, data: { namespace: config.namespace, collection: config.collection, version: "1", through } }],
        result: undefined,
      })))).pipe(Effect.mapError(storageFailure))
      return { sources: parts.length, refused }
    }), { concurrency: 1 })
    const through = endings.at(-1)?.seq ?? after
    const more = yield* sessions.read(address, { after: through, kinds: captureKinds, limit: 1 }).pipe(Effect.mapError(storageFailure))
    const refused = synced.flatMap((turn) => turn.refused)
    return { sources: synced.reduce((sum, turn) => sum + turn.sources, 0), through, hasMore: more.length > 0,
      ...(limited && events.some((event) => event.seq > through) ? { stalled: "page-limit" as const } : {}),
      ...(refused.length === 0 ? {} : { refused }),
    }
  })
  return MemoryCapture.of({
    sync,
    backfill: Effect.fn("memory.capture.backfill")(function* (input) {
      const page = yield* sessions.list(input).pipe(Effect.mapError(storageFailure))
      const captured = yield* Effect.forEach(page.sessions, (view) => sync({ owner: input.owner, id: view.header.id }), { concurrency: 1 })
      const refused = captured.reduce((total, result) => total + (result.refused?.length ?? 0), 0)
      return { sources: captured.reduce((total, result) => total + result.sources, 0), next: page.next, ...(refused === 0 ? {} : { refused }) }
    }),
  })
}))

/** Capture after acknowledged commits; processing continues in the runtime memory worker. @public */
export const memoryCapturePlugin = definePlugin({
  id: "@xandreed/plugin-memory/capture", version: "0.19.0", scope: "session",
  config: MemoryCaptureConfig, defaults: memoryCaptureDefaults,
  requires: [Sessions, LongTermMemory], provides: [MemoryCapture], contributes: [CommittedTurnObservers],
  layer: (config) => Layer.effect(CommittedTurnObservers, Effect.gen(function* () {
    const capture = yield* MemoryCapture
    return [{
      id: "@xandreed/plugin-memory/capture",
      committed: (turn) => capture.sync(turn.session).pipe(Effect.asVoid, Effect.mapError((cause) => new HarnessError({ code: "memory.capture", message: "Committed memory capture could not finish", cause }))),
    }]
  })).pipe(Layer.provideMerge(MemoryCaptureLive(config))),
})
