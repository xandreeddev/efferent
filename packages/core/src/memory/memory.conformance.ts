import { Array as Arr, Context, Deferred, Effect, Fiber, Option, Ref, Schema } from "effect"
import type { Scope } from "effect"
import { ConformanceFailure } from "../conformance.entity.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import { failureCode, pixelPng } from "../conformance.functions.js"
import { mediaFromBase64, mediaLabel, mediaSlotsOf } from "../domain/media.entity.functions.js"
import type { Media } from "../domain/media.entity.js"
import { ConversationId, ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import type { ConversationMemory, LogHandle, MemorySession, ToolViews } from "../ports/memory.port.js"
import { draftOfEntry, entriesOfEvents, turnStartedDraft } from "../session/session-event.entity.functions.js"
import type { SessionDraft, SessionLogEvent } from "../session/session-log.entity.js"
import { InboxItemId } from "../session/sessions.entity.js"
import type { TurnError } from "../session/sessions.entity.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { userRoleMessageOf } from "../turn/user-message.entity.functions.js"
import { canonicalJson } from "./memory-log.entity.functions.js"
import { ArtifactId, LogEntry, SectionId } from "./memory-log.entity.js"

const conversation = ConversationId.make("00000000-0000-4000-8000-00000000c0f0")
/** The turn's first run, and its second: what a build names for its step context. */
const firstRun = RunOrdinal.make(0)
const secondRun = RunOrdinal.make(1)

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
      : draftOfEntry(entry)).pipe(Effect.mapError(codec)), { concurrency: 1 }).pipe(
      Effect.map((drafts) => drafts.flatMap(Option.toArray)),
      Effect.flatMap((drafts) => Effect.forEach(drafts, (draft) => storedJson(draft.data).pipe(Effect.mapError(codec)), { concurrency: 1 }).pipe(
        Effect.flatMap((data) => Ref.update(stored, (all) => [...all, ...Arr.zip(drafts, data).map(([draft, json], index): SessionLogEvent => ({
          session: conversation, seq: all.length + index + 1, turn: draft.turn, kind: draft.kind, at: 0, data: json,
        }))])),
      )),
    ),
  }
  return { stored, log }
})

const artifact = { id: ArtifactId.make("artifact-1"), kind: "image" as const, mediaType: "image/png", url: "https://example.test/artifact-1.png", alt: Option.some("a figure") }
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
const encodeLog = Schema.encodeEffect(Schema.Array(LogEntry))
/** The entries as canonical JSON, the form two logs are compared in; entries that do not encode fail `check`. */
const encodeEntries = (check: string, entries: ReadonlyArray<LogEntry>): Effect.Effect<string, ConformanceFailure> =>
  encodeLog(entries).pipe(Effect.map(canonicalJson), Effect.mapError((error) => new ConformanceFailure({ check, message: `the entries do not encode: ${error.message}` })))

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
 * artifacts kept, a pure build, the step context only when asked and only its own run's,
 * append-only maintenance, a reference transcript without tool traffic, and
 * a message's images kept through a reopen and built (never with an empty
 * text part): the current turn's as image parts, an earlier turn's as image
 * parts or label lines; a tool result's images stored once, kept through a
 * reopen, and the current turn's built as the result's images. Those checks
 * need a media budget that admits one small image, as the memory plugins'
 * defaults do: a strategy set to send none (`maxImages: 0` or
 * `maxChars: 0`) fails them, as it fails `turnConformance`'s.
 * `services` are the turn services the strategy needs (a summarizer…); each
 * session is opened with them provided.
 */
export const memoryConformance = (memory: Memory, services: Context.Context<never> = Context.empty()): ReadonlyArray<ConformanceCheck> => {
  const check = (name: string, id: string, body: (open: (log: LogHandle, runId: string) => Effect.Effect<MemorySession, TurnError, Scope.Scope>, log: LogHandle) => Effect.Effect<void, ConformanceFailure | TurnError, Scope.Scope>): ConformanceCheck => ({
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const stored = yield* inMemoryLog
      yield* body((log, runId) => memory.open({ conversation, runId: RunId.make(runId), log }).pipe(Effect.provide(services)), stored.log)
    })).pipe(Effect.catch((error) => error._tag === "ConformanceFailure" ? Effect.fail(error) : fail(id)(`${failureCode(error)}: ${error.message}`))),
  })
  return [
    check("entries get their own ids, <runId>:<n>, continuing across reopens", "ids", (open, log) => Effect.gen(function* () {
      const first = yield* open(log, "run-1")
      const a = yield* first.record([said("one"), { _tag: "TurnContext", sectionId: SectionId.make("s"), version: "1", text: "context" }], 0)
      const again = yield* open(log, "run-1")
      const b = yield* again.record([{ _tag: "TurnEnded", outcome: "completed", reply: Option.none() }], 0)
      const other = yield* open(log, "run-2")
      const c = yield* other.record([said("two")], 0)
      const ids = [...a, ...b, ...c].map((entry) => String(entry.id))
      yield* expect("ids", ids.join() === "run-1:0,run-1:1,run-1:2,run-2:0", `ids were ${ids.join()}`)
    })),
    check("an alternate commit controls persistence and ids, including rejected and uncertain acknowledgements", "alternate-commit", (open, log) => Effect.gen(function* () {
      const normal = yield* Ref.make(0)
      const calls = yield* Ref.make(0)
      const session = yield* open({ ...log, append: (entries) => Ref.update(normal, (n) => n + 1).pipe(Effect.andThen(log.append(entries))) }, "run-1")
      yield* session.record([said("one")], 0)
      const body = { _tag: "StepContext" as const, step: 0, run: firstRun, text: "steer" }
      const rejected = yield* session.record([body], 0, () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(false)))
      yield* expect("alternate-commit", rejected.length === 0 && (yield* session.entries).length === 1 && (yield* log.read).length === 1, "a rejected alternate commit appended entries or changed the cache")
      const accepted = yield* session.record([body], 0, (entries) => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(log.append(entries)), Effect.as(true)))
      yield* expect("alternate-commit", accepted[0]?.id === "run-1:1" && (yield* Ref.get(normal)) === 1 && (yield* Ref.get(calls)) === 2, "the alternate callback was bypassed, called twice, or consumed an id on rejection")
      const refused = new HarnessError({ code: "memory.log", message: "the alternate commit was refused" })
      const refusal = yield* Effect.result(session.record([body], 0, () => Effect.fail(refused)))
      const afterRefusal = yield* session.record([body], 0)
      yield* expect("alternate-commit", refusal._tag === "Failure" && refusal.failure === refused && afterRefusal[0]?.id === "run-1:2", "a refused alternate commit changed its error or consumed an id")
      const lost = new HarnessError({ code: "memory.log", message: "the alternate commit acknowledgement was lost" })
      const uncertain = yield* Effect.result(session.record([body], 0, (entries) => log.append(entries).pipe(Effect.andThen(Effect.fail(lost)))))
      const afterUncertain = yield* session.record([body], 0)
      yield* expect("alternate-commit", uncertain._tag === "Failure" && uncertain.failure === lost && afterUncertain[0]?.id === "run-1:4", "a committed alternate append lost its error or reused its entry id")
      yield* expect("alternate-commit", (yield* encodeEntries("alternate-commit", yield* session.entries)) === (yield* encodeEntries("alternate-commit", yield* log.read)), "an uncertain alternate acknowledgement left the session cache behind storage")
    })),
    check("a reopened session reads back exactly what was recorded, and builds the same context", "reopen", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      const reopened = yield* open(log, "run-1")
      yield* expect("reopen", (yield* encodeEntries("reopen", yield* reopened.entries)) === (yield* encodeEntries("reopen", yield* session.entries)), "the reopened log differs")
      const [left, right] = [yield* session.build({ stepContext: "tail", run: firstRun }), yield* reopened.build({ stepContext: "tail", run: firstRun })]
      yield* expect("reopen", left.fingerprint === right.fingerprint, "the reopened session builds a different context")
    })),
    check("tool results keep their views and artifacts", "views", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      const reopened = yield* open(log, "run-1")
      const raw = (yield* reopened.entries).find((entry) => entry.body._tag === "ToolResult")
      const result = raw === undefined ? undefined : Option.getOrUndefined(yield* reopened.resolve(raw.id))
      yield* expect("views", result?.body._tag === "ToolResult" && result.body.view.startsWith("VIEW ") && result.body.artifacts[0]?.id === artifact.id,
        "the tool result lost its view or artifacts")
    })),
    check("a tool's encoded result is durable while its view is still pending", "raw-result-durable", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      const viewing = yield* Deferred.make<void>()
      const held: ToolViews = { ...views, view: () => Deferred.succeed(viewing, undefined).pipe(Effect.andThen(Effect.never)) }
      const recording = yield* session.recordTail(toolTail, held, 0).pipe(Effect.forkChild)
      const entered = yield* Deferred.await(viewing).pipe(Effect.timeoutOption("1 second"))
      const stored = yield* log.read
      yield* Fiber.interrupt(recording)
      yield* expect("raw-result-durable", Option.isSome(entered), "the result's view was not called")
      const result = stored.find((entry) => entry.body._tag === "ToolResult")
      yield* expect("raw-result-durable", result?.body._tag === "ToolResult" && canonicalJson(result.body.encoded) === canonicalJson({ id: "record-alpha" }), "the encoded result was not durable before its view ran")
      const reopened = yield* open(log, "run-1")
      const built = yield* reopened.build({ stepContext: "tail", run: firstRun })
      yield* expect("raw-result-durable", !canonicalJson(built.messages).includes("ToolInterrupted") && canonicalJson(built.messages).includes("record-alpha"), "the reopened result was replaced by an interrupted call")
    })),
    check("recordTail keeps an explicit run ordinal on requests and raw results through reopening", "run-ordinal", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* session.recordTail(toolTail, views, 0, firstRun)
      yield* session.recordTail(toolTail, views, 0, secondRun)
      const reopened = yield* open(log, "run-1")
      const runs = (yield* reopened.entries).flatMap((entry) => entry.body._tag === "Message" || entry.body._tag === "ToolResult" ? [entry.body.run] : [])
      yield* expect("run-ordinal", runs.length === 4 && runs.every((run, index) => run === (index < 2 ? firstRun : secondRun)), "the reopened calls lost or mixed their explicit run ordinals")
    })),
    check("build is a pure fold of the log", "pure", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      const [left, right] = [yield* session.build({ stepContext: "tail", run: firstRun }), yield* session.build({ stepContext: "tail", run: firstRun })]
      yield* expect("pure", left.fingerprint === right.fingerprint && canonicalJson(left.messages) === canonicalJson(right.messages), "two builds differ")
    })),
    check("the step context closes the tail only when asked, and only its own run's", "step-context", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* session.record([said("find alpha")], 0)
      yield* session.record([{ _tag: "StepContext", step: 0, run: firstRun, text: "STEP-MARK" }], 0)
      const tail = canonicalJson((yield* session.build({ stepContext: "tail", run: firstRun })).messages)
      const none = canonicalJson((yield* session.build({ stepContext: "none", run: firstRun })).messages)
      const later = canonicalJson((yield* session.build({ stepContext: "tail", run: secondRun })).messages)
      yield* expect("step-context", tail.includes("STEP-MARK") && !none.includes("STEP-MARK"), "the step context is misplaced")
      yield* expect("step-context", !later.includes("STEP-MARK"), "the turn's second run was built with the first run's step context")
    })),
    check("maintenance only appends to the log", "append-only", (open, log) => Effect.gen(function* () {
      const session = yield* open(log, "run-1")
      yield* recordTurn(session, "find alpha", "found record-alpha")
      yield* session.record([said("and beta")], 0)
      const before = yield* session.entries
      yield* session.maintain({ phase: "turn-start", lastUsage: Option.none(), budgetTokens: 100_000, views })
      yield* session.maintain({ phase: "step", lastUsage: Option.none(), budgetTokens: 100_000, views })
      const after = yield* session.entries
      yield* expect("append-only", (yield* encodeEntries("append-only", after.slice(0, before.length))) === (yield* encodeEntries("append-only", before)), "maintenance rewrote earlier entries")
    })),
    check("a message's images survive a reopen; the current turn's are built as image parts, an earlier turn's as image parts or label lines", "attachments", (open, log) => Effect.gen(function* () {
      const image: Media = yield* mediaFromBase64(pixelPng, { name: "pixel.png" }).pipe(
        Effect.mapError((error) => new ConformanceFailure({ check: "attachments", message: error.message })),
      )
      const session = yield* open(log, "run-1")
      yield* session.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "what is this?", attachments: [image] }) }], 0)
      yield* session.record([{ _tag: "TurnEnded", outcome: "completed", reply: Option.some("a pixel") }], 0)
      const other = yield* open(log, "run-2")
      yield* other.record([{ _tag: "TurnStarted", userMessage: new UserMessage({ text: "", attachments: [image] }) }], 0)
      const reopened = yield* open(log, "run-2")
      yield* expect("attachments", (yield* encodeEntries("attachments", yield* reopened.entries)) === (yield* encodeEntries("attachments", yield* other.entries)), "the reopened log lost or changed an image")
      const users = (yield* reopened.build({ stepContext: "tail", run: firstRun })).messages.filter((message) => message.role === "user")
      const shown = users.map((message) => typeof message.content === "string"
        ? message.content.includes(mediaLabel(image)) ? "label" : "missing"
        : message.content.some((part) => part.type === "text" && part.text.length === 0) ? "empty text"
          : message.content.some((part) => part.type === "media" && part.fingerprint === image.fingerprint && part.data === image.data) ? "image" : "missing")
      const [earlier, current] = [shown[0] ?? "missing", shown[1] ?? "missing"]
      yield* expect("attachments", shown.length === 2 && (earlier === "image" || earlier === "label") && current === "image",
        `the earlier message showed its image as ${earlier} (an image or its label line), the current turn's as ${current} (its image, with the same data)`)
      const firstText = Option.match(Option.fromNullishOr(users[0]), {
        onNone: () => "",
        onSome: (message) => typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
      })
      yield* expect("attachments", firstText.includes("what is this?"), "the first message lost its text")
    })),
    check("an inbox user message keeps its images and real intent through reopening and transcripts", "inbox-intent", (open, log) => Effect.gen(function* () {
      const image = yield* mediaFromBase64(pixelPng, { name: "steer.png" }).pipe(Effect.mapError((error) => new ConformanceFailure({ check: "inbox-intent", message: error.message })))
      const session = yield* open(log, "run-1")
      yield* session.record([said("first request")], 0)
      yield* session.record([
        { _tag: "Message", inbox: InboxItemId.make("steer-1"), run: firstRun, message: userRoleMessageOf(new UserMessage({ text: "steered request", attachments: [image] })) },
        { _tag: "Message", message: { role: "user", content: "host corrective" } },
      ], 1)
      const reopened = yield* open(log, "run-1")
      const entries = yield* reopened.entries
      const encoded = yield* encodeEntries("inbox-intent", entries)
      yield* expect("inbox-intent", entries.some((entry) => entry.body._tag === "Message" && entry.body.inbox === "steer-1") && encoded.split(image.data).length - 1 === 1, "the inbox identity or raw image was lost or duplicated")
      const messages = (yield* reopened.build({ stepContext: "tail", run: firstRun })).messages
      yield* expect("inbox-intent", messages.some((message) => message.role === "user" && typeof message.content !== "string" && message.content.some((part) => part.type === "media" && part.data === image.data)), "the current steer image was not sent")
      const reference = canonicalJson(yield* reopened.transcript("reference"))
      const raw = canonicalJson(yield* reopened.transcript("raw"))
      yield* expect("inbox-intent", reference.includes("steered request") && reference.includes(mediaLabel(image)) && !reference.includes("host corrective") && !reference.includes(image.data) && !raw.includes(image.data), "transcripts lost the steer, included a corrective as intent, or leaked image bytes")
    })),
    check("a tool result's images survive a reopen, stored once, and the current turn's reach the build as the result's images", "tool-media", (open, log) => Effect.gen(function* () {
      const image: Media = yield* mediaFromBase64(pixelPng, { name: "shot.png" }).pipe(
        Effect.mapError((error) => new ConformanceFailure({ check: "tool-media", message: error.message })),
      )
      const imaging: ToolViews = { ...views, view: (_tool, encoded) => Effect.succeed({ text: "a screenshot", version: "1", subjects: [], artifacts: [], pinned: false, media: mediaSlotsOf(encoded) }) }
      const session = yield* open(log, "run-1")
      yield* session.record([said("how does it look?")], 0)
      yield* session.recordTail([
        { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName: "screenshot", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: callId, toolName: "screenshot", output: { shot: image }, isError: false }] },
      ], imaging, 0)
      const reopened = yield* open(log, "run-1")
      const entries = yield* reopened.entries
      const encoded = yield* encodeEntries("tool-media", entries)
      yield* expect("tool-media", encoded === (yield* encodeEntries("tool-media", yield* session.entries)), "the reopened log lost or changed the result's image")
      yield* expect("tool-media", encoded.split(image.data).length - 1 === 1, "the result's image is not stored exactly once")
      const parts = (yield* reopened.build({ stepContext: "tail", run: firstRun })).messages.flatMap((message) => message.role === "tool" ? message.content : [])
      yield* expect("tool-media", parts.some((part) => (part.media ?? []).some((media) => media.fingerprint === image.fingerprint && media.data === image.data)),
        "the current turn's tool result was built without its image")
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
