import { Context, Effect, Option, Ref, Schema } from "effect"
import type { Scope } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { ConversationId, ToolCallId } from "../domain/message.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import type { ConversationMemory, LogHandle, MemorySession, ToolViews } from "../ports/memory.port.js"
import { draftOfEntry, entriesOfEvents, turnStartedDraft } from "../session/session-event.entity.functions.js"
import type { SessionDraft, SessionLogEvent } from "../session/session-log.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { canonicalJson } from "./memory-log.entity.functions.js"
import { LogEntry } from "./memory-log.entity.js"

const conversation = ConversationId.make("00000000-0000-4000-8000-00000000c0f0")

/**
 * A memory log held as session events, through the storage codec: what a
 * turn's log does, without a session. The user's message is stored as its
 * own `turn.started`, as a session's begin stores it.
 */
export const inMemoryLog = Effect.gen(function* () {
  const stored = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([])
  const codec = (error: { readonly message: string }) => new HarnessError({ code: "memory.log", message: error.message })
  const log: LogHandle = {
    read: Ref.get(stored).pipe(Effect.flatMap(entriesOfEvents), Effect.mapError(codec)),
    append: (entries) => Effect.forEach(entries, (entry): Effect.Effect<Option.Option<SessionDraft>, HarnessError> => (entry.body._tag === "TurnStarted"
      ? turnStartedDraft(entry.turn, {
        runId: entry.runId, key: entry.runId, origin: "user", userMessage: entry.body.userMessage, command: {}, claimed: [], entry: entry.id, at: entry.at,
      }).pipe(Effect.map(Option.some))
      : draftOfEntry(entry)).pipe(Effect.mapError(codec))).pipe(
      Effect.flatMap((drafts) => Ref.update(stored, (all) => [...all, ...drafts.flatMap(Option.toArray).map((draft, index): SessionLogEvent => ({
        session: conversation, seq: all.length + index + 1, turn: draft.turn, kind: draft.kind, at: 0, data: JSON.parse(JSON.stringify(draft.data)),
      }))])),
    ),
  }
  return { stored, log }
})

const artifact = { id: "artifact-1", kind: "image" as const, mediaType: "image/png", url: "https://example.test/artifact-1.png", alt: Option.some("a figure") }
const views: ToolViews = {
  view: (_tool, encoded) => Effect.succeed({ text: `VIEW ${canonicalJson(encoded)}`, version: "1", subjects: [], artifacts: [artifact], pinned: false }),
  compact: () => Effect.succeed(Option.none()),
  digest: () => Effect.succeed(Option.none()),
}
const callId = ToolCallId.make("conformance-call")
const toolTail: ReadonlyArray<AgentMessage> = [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "lookup", input: { query: "alpha" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: "lookup", output: { id: "record-alpha" }, isError: false }] },
]
const encodeEntries = (entries: ReadonlyArray<LogEntry>) => canonicalJson(Schema.encodeSync(Schema.Array(LogEntry))(entries))

type Memory = Context.Service.Shape<typeof ConversationMemory>

const fail = (check: string) => (message: string) => Effect.fail(new ConformanceFailure({ check, message }))
const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> => holds ? Effect.void : fail(check)(message)

/** The user's message of a recorded turn. */
const said = (text: string) => ({ _tag: "TurnStarted" as const, userMessage: new UserMessage({ text }) })

/** One recorded turn: the user's message, a tool call with its result, the reply. */
const recordTurn = (session: MemorySession, userMessage: string, reply: string) => Effect.gen(function* () {
  yield* session.record([said(userMessage)], 0)
  yield* session.recordTail(toolTail, views, 0)
  yield* session.record([{ _tag: "TurnEnded", outcome: "completed", reply: Option.some(reply) }], 1)
})

/**
 * The ConversationMemory contract, as checks any strategy must pass: own
 * entry ids, a log that reads back exactly after a reopen, views and
 * artifacts kept, a pure build, the step context only when asked,
 * append-only maintenance and a reference transcript without tool traffic.
 * `services` are the turn services the strategy needs (a summarizer…); each
 * session is opened with them provided.
 */
export const memoryConformance = (memory: Memory, services: Context.Context<never> = Context.empty()): ReadonlyArray<ConformanceCheck> => {
  const check = (name: string, id: string, body: (open: (log: LogHandle, runId: string) => Effect.Effect<MemorySession, HarnessError, Scope.Scope>, log: LogHandle) => Effect.Effect<void, ConformanceFailure | HarnessError, Scope.Scope>): ConformanceCheck => ({
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const stored = yield* inMemoryLog
      yield* body((log, runId) => memory.open({ conversation, runId, log }).pipe(Effect.provide(services)), stored.log)
    })).pipe(Effect.catchTag("HarnessError", (error) => fail(id)(`${error.code}: ${error.message}`))),
  })
  return [
    check("entries get their own ids, <runId>:<n>, continuing across reopens", "ids", (open, log) => Effect.gen(function* () {
      const first = yield* open(log, "run-1")
      const a = yield* first.record([said("one"), { _tag: "TurnContext", sectionId: "s", version: "1", text: "context" }], 0)
      const again = yield* open(log, "run-1")
      const b = yield* again.record([{ _tag: "TurnEnded", outcome: "completed", reply: Option.none() }], 0)
      const other = yield* open(log, "run-2")
      const c = yield* other.record([said("two")], 0)
      const ids = [...a, ...b, ...c].map((entry) => String(entry.id))
      yield* expect("ids", ids.join() === "run-1:0,run-1:1,run-1:2,run-2:0", `ids were ${ids.join()}`)
    })),
    check("a reopened session reads back exactly what was recorded, and builds the same context", "reopen", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      const reopened = yield* open(log, "run-1")
      yield* expect("reopen", encodeEntries(yield* reopened.entries) === encodeEntries(yield* session.entries), "the reopened log differs")
      const [left, right] = [yield* session.build({ stepContext: "tail" }), yield* reopened.build({ stepContext: "tail" })]
      yield* expect("reopen", left.fingerprint === right.fingerprint, "the reopened session builds a different context")
    })),
    check("tool results keep their views and artifacts", "views", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      const reopened = yield* open(log, "run-1")
      const result = (yield* reopened.entries).find((entry) => entry.body._tag === "ToolResult")
      yield* expect("views", result?.body._tag === "ToolResult" && result.body.view.startsWith("VIEW ") && result.body.artifacts[0]?.id === artifact.id,
        "the tool result lost its view or artifacts")
    })),
    check("build is a pure fold of the log", "pure", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      const [left, right] = [yield* session.build({ stepContext: "tail" }), yield* session.build({ stepContext: "tail" })]
      yield* expect("pure", left.fingerprint === right.fingerprint && canonicalJson(left.messages) === canonicalJson(right.messages), "two builds differ")
    })),
    check("the step context closes the tail only when asked", "step-context", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* session.record([said("find alpha")], 0)
      yield* session.record([{ _tag: "StepContext", step: 0, text: "STEP-MARK" }], 0)
      const tail = canonicalJson((yield* session.build({ stepContext: "tail" })).messages)
      const none = canonicalJson((yield* session.build({ stepContext: "none" })).messages)
      yield* expect("step-context", tail.includes("STEP-MARK") && !none.includes("STEP-MARK"), "the step context is misplaced")
    })),
    check("maintenance only appends to the log", "append-only", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      yield* session.record([said("and beta")], 0)
      const before = yield* session.entries
      yield* session.maintain({ phase: "turn-start", lastUsage: Option.none(), budgetTokens: 100_000, views })
      yield* session.maintain({ phase: "step", lastUsage: Option.none(), budgetTokens: 100_000, views })
      const after = yield* session.entries
      yield* expect("append-only", encodeEntries(after.slice(0, before.length)) === encodeEntries(before), "maintenance rewrote earlier entries")
    })),
    check("the reference transcript holds user messages and replies, never tool traffic", "reference", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      const transcript = yield* session.transcript("reference")
      const text = canonicalJson(transcript)
      yield* expect("reference", transcript.every((message) => message.role === "user" || message.role === "assistant") && text.includes("find alpha")
        && text.includes("found record-alpha") && !text.includes("tool-call"), `reference transcript: ${text.slice(0, 300)}`)
    })),
  ]
}
