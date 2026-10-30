import { describe, expect, test } from "bun:test"
import { Context, Deferred, Duration, Effect, Exit, Layer, Match, Option, Ref, Schema, Scope, Stream } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import {
  ActionPolicy,
  Agent,
  AssistantMessage,
  awaitIdle,
  ConversationId,
  defineCapability,
  defineHostEvent,
  defineSkill,
  defineTool,
  Failure,
  HarnessError,
  harnessCodeOf,
  onEvent,
  onTool,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  subscribeAll,
  TurnAdmissionOpen,
  turnBeginCodes,
  TurnEndedData,
  turnEndedOf,
  turnEndingOf,
  TurnEvents,
  UserMessage,
} from "@xandreed/sdk"
import type { Capability, SessionAddress, SessionLog, Turn, TurnBeginError, TurnError, TurnEvent, TurnEventOf, TurnEventsService, TurnOutcome } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { decodeSse, RenderFeed, RenderFeedLive, renderFeedDefaults, SessionsJournalTailLive, sseHeaders, SseTransport } from "@xandreed/plugin-render"
import type { FeedOptions, FeedPayload, FeedProjection, SsePeer } from "@xandreed/plugin-render"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"

/*
 * The events guide (docs/events.md), as code that runs. Every `#region`
 * below is a snippet of the guide: `bun run docs:generate`
 * (scripts/sync-guides.ts) copies it there with the imports it uses, and
 * `bun run verify:packages` runs the HTTP recipe's regions on Node and on
 * Bun against the packed packages. Regions import only public packages.
 */

// #region host
/** What a server instance is built from. */
export interface HostOptions {
  /** The session store every instance shares (your database; `SessionLogMemoryLive` is one process's). */
  readonly log: Layer.Layer<SessionLog>
  /** From `@xandreed/plugin-models`, or any effect/ai provider. */
  readonly model: LanguageModel.LanguageModel
  readonly capabilities?: ReadonlyArray<Capability>
  readonly feed?: FeedOptions
}

/**
 * One server instance: the agent, the services it was given (the Sessions
 * it writes through, and their activity probe), the journal feed and the model.
 */
export const makeHost = (options: HostOptions) => Effect.gen(function* () {
  // Lease ownership, the default written out: instances share the log, and the keep-alive
  // holds a turn through a step that writes nothing for longer than the lease (a long model call, a slow tool).
  const services = yield* Layer.build(SessionsPluginLive({ ownership: { mode: "lease", ttlMs: 60_000, renew: { everyMs: 20_000 } } }).pipe(
    Layer.provide(Layer.merge(options.log, TurnAdmissionOpen))))
  const agent = yield* Agent.define({
    services, // agent.activity counts the turns these Sessions hold
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: options.capabilities ?? [],
    turnServices: [LanguageModel.LanguageModel],
  })
  const feed = Context.get(yield* Layer.build(RenderFeedLive(options.feed ?? renderFeedDefaults).pipe(
    Layer.provide(SessionsJournalTailLive()),
    Layer.provide(Layer.succeedContext(services)))), RenderFeed)
  return { agent, services, sessions: Context.get(services, Sessions), feed, model: options.model }
})
export type Host = Effect.Success<ReturnType<typeof makeHost>>

/** Built once per server instance (a module-level promise in Next.js); its scope is never closed. */
export const startHost = (options: HostOptions): Promise<Host> =>
  Effect.runPromise(Scope.make().pipe(Effect.flatMap((scope) => makeHost(options).pipe(Scope.provide(scope)))))
// #endregion host

// #region progress
/** One SSE frame for the client: an event name and its JSON data. */
export interface Frame {
  readonly event: string
  readonly data: Readonly<Record<string, unknown>>
}

/** The bus events a client is shown, as frames; `None` skips one. Tool input and output stay on the server. */
export const progressOf = (event: TurnEvent): Option.Option<Frame> => Match.value(event).pipe(
  Match.tag("step.started", (e) => Option.some({ event: "step", data: { step: e.step, state: "started" } })),
  Match.tag("assistant.delta", (e) => e.channel === "text" ? Option.some({ event: "delta", data: { step: e.step, id: e.id, text: e.delta } }) : Option.none()),
  Match.tag("stream.fallback", (e) => Option.some({ event: "fallback", data: { step: e.step } })),
  Match.tag("tool.started", (e) => Option.some({ event: "tool", data: { step: e.step, id: e.invocationId, tool: e.tool, state: "running" } })),
  Match.tag("tool.progress", (e) => e.channel === "status" ? Option.some({ event: "tool", data: { step: e.step, id: e.invocationId, tool: e.tool, state: "running", status: e.text } }) : Option.none()),
  Match.tag("tool.refused", (e) => Option.some({ event: "tool", data: { step: e.step, id: e.invocationId, tool: e.tool, state: "refused", reason: e.reason } })),
  Match.tag("tool.completed", (e) => Option.some({ event: "tool", data: { step: e.step, id: e.invocationId, tool: e.tool, state: e.ok ? "done" : "failed" } })),
  Match.tag("assistant.message", (e) => Option.some({ event: "message", data: { step: e.step, text: e.text } })),
  Match.tag("step.ended", (e) => Option.some({ event: "step", data: { step: e.step, state: e.status } })),
  Match.orElse(() => Option.none()),
)
// #endregion progress

// #region stream
/** Sends one frame to the client. It must never fail (see `clientPush`). */
export type Push = (frame: Frame) => Effect.Effect<void>

/**
 * `use` for a turn streamed to a client: one background subscription (one
 * ordered lane, off the loop's path) for every frame, each tagged with the
 * turn's number, then the run.
 */
export const streamTo = (push: Push) => (turn: Turn): Effect.Effect<TurnOutcome, TurnError, Scope.Scope> => Effect.gen(function* () {
  yield* turn.events.subscribe(progressOf, (frame) => push({ event: frame.event, data: { turn: turn.turn, ...frame.data } }), { mode: "background" })
  yield* turn.tools.select(turn.userMessage) // the always-on skills, and the matcher's choice
  const result = yield* turn.run({}) // streamed by default (limits.streaming)
  return { outcome: result.outcome, reply: Option.some(result.text) }
})
// #endregion stream

// #region push
const sseFrame = (frame: Frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`
const settle = () => undefined

/** Whether the client took `bytes` within `timeout`: a write still waiting then, or one that failed (the client left), was not. */
export const writeWithin = (writer: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array, timeout: Duration.Input) =>
  Effect.promise(() => writer.write(bytes).then(() => true, () => false)).pipe(
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse(() => false)))

/**
 * Ends a client's stream without waiting: a stream aborted while a write
 * still waits settles neither until the client reads again or leaves.
 */
export const closeStream = (writer: WritableStreamDefaultWriter<Uint8Array>) => Effect.sync(() => writer.close().then(settle, settle))

/**
 * A client's stream as a `Push` that never fails and never holds the turn
 * up: a write the client has not taken within `timeout` marks it gone and
 * aborts the stream, and every later frame is dropped. A handler that fails
 * fails the turn; one that never returns keeps it from recording its reply.
 */
export const clientPush = (writer: WritableStreamDefaultWriter<Uint8Array>, timeout: Duration.Input = "2 seconds") => Effect.gen(function* () {
  const gone = yield* Ref.make(false)
  const encoder = new TextEncoder()
  const push: Push = (frame) => Effect.gen(function* () {
    if (yield* Ref.get(gone)) return
    if (yield* writeWithin(writer, encoder.encode(sseFrame(frame)), timeout)) return
    yield* Ref.set(gone, true)
    yield* Effect.sync(() => writer.abort().then(settle, settle))
  })
  return push
})
// #endregion push

// #region observe
/** For the turn's `layer`: a subscription there sees `turn.started` (with `meta` and `resumes`), which `use` never does. */
export const onTurnStarted = (handle: (event: TurnEventOf<"turn.started">) => Effect.Effect<void>) =>
  Layer.effectDiscard(TurnEvents.pipe(Effect.flatMap((events) =>
    events.subscribe((event) => event._tag === "turn.started" ? Option.some(event) : Option.none(), handle))))

/**
 * From `use`: a subscription moved into `outer`, a scope the caller keeps
 * open past the turn, the only kind that sees `turn.ended`. Its handler runs
 * after the turn's own scopes have closed, and must not fail.
 */
export const onTurnEnded = (outer: Scope.Scope, handle: (event: TurnEventOf<"turn.ended">) => Effect.Effect<void>) => (turn: Turn) =>
  turn.events.subscribe((event) => event._tag === "turn.ended" ? Option.some(event) : Option.none(), handle).pipe(Scope.provide(outer))
// #endregion observe

// #region tools
export const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ found: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

/** Typed reactions to `lookup`'s successful calls, and a line for every call refused or failed. */
export const watchTools = (turn: Turn, report: (line: string) => Effect.Effect<void>) => subscribeAll(turn.events, [
  onTool(Lookup, ({ input, result }) => report(`lookup "${input.query}" found ${result.found}`)),
  onEvent("tool.refused", (event) => report(`${event.tool} refused (${event.reason}): ${event.message}`)),
  onEvent("tool.completed", (event) => event.ok ? Effect.void : report(`${event.tool} failed`)),
  onEvent("step.ended", (event) => {
    const notOk = event.results.filter((result) => !result.ok).map((result) => result.tool)
    return notOk.length === 0 ? Effect.void : report(`step ${event.step}: not ok ${notOk.join(", ")}`)
  }),
])
// #endregion tools

// #region host-events
/** The application's own event: typed by its schema, journaled under its name, seen by the session's followers. */
export const Progress = defineHostEvent("app.progress", Schema.Struct({ stage: Schema.String, done: Schema.Number }))

/** Publish it from `use` (`turn.events`), a task, a tool (`RunContext.events`) or a session plugin (`TurnEvents`). */
export const reportStage = (events: TurnEventsService, stage: string, done: number) => Progress.publish(events, { stage, done })
// #endregion host-events

// #region journal
/** The events stored after `cursor`, oldest first, and the cursor to read from next. */
export const readAfter = (sessions: typeof Sessions.Service, address: SessionAddress, cursor: number) =>
  sessions.read(address, { after: cursor, limit: 500 }).pipe(Effect.map((events) => ({
    events,
    cursor: events.reduce((last, event) => Math.max(last, event.seq), cursor),
  })))

/** How each turn of a session ended, as stored: the reason and, when it failed, the failing error's code. */
export const endingsOf = (sessions: typeof Sessions.Service, address: SessionAddress) =>
  sessions.read(address, { kinds: ["turn.ended"] }).pipe(Effect.flatMap((events) => Effect.forEach(events, (event) =>
    turnEndedOf(event).pipe(Effect.map((ended) => ({
      turn: Option.getOrNull(event.turn),
      reason: ended.reason,
      code: Option.getOrNull(Option.map(ended.failure, (failure) => failure.code)),
    }))))))

const StoredReply = Schema.Struct({ body: Schema.Struct({ outcome: Schema.String, reply: Schema.NullOr(Schema.String) }) })

/** How a turn ended and what it replied, as the journal has it. */
export interface StoredAnswer {
  readonly turn: number
  readonly reason: string
  readonly reply: string | null
}

/** What the turn begun with `key` answered, from the journal: none until that turn has ended. */
export const storedAnswer = (sessions: typeof Sessions.Service, address: SessionAddress, key: string) => Effect.gen(function* () {
  const turn = yield* sessions.lookup(address, key)
  if (Option.isNone(turn)) return Option.none<StoredAnswer>()
  const own = (yield* sessions.read(address, { kinds: ["turn.reply", "turn.ended"] })).filter((event) => Option.contains(event.turn, turn.value))
  const ended = Option.fromNullishOr(own.find((event) => event.kind === "turn.ended"))
  if (Option.isNone(ended)) return Option.none()
  const ending = yield* turnEndedOf(ended.value)
  const reply = Option.fromNullishOr(own.find((event) => event.kind === "turn.reply")).pipe(
    Option.flatMap((event) => Schema.decodeUnknownOption(StoredReply)(event.data)),
    Option.flatMap((stored) => Option.fromNullishOr(stored.body.reply)))
  return Option.some<StoredAnswer>({ turn: turn.value, reason: ending.reason, reply: Option.getOrNull(reply) })
})
// #endregion journal

// #region project
const Said = Schema.Struct({ userMessage: Schema.Struct({ text: Schema.String }) })
const Answered = Schema.Struct({ step: Schema.Int, body: Schema.Struct({ message: AssistantMessage }) })
const pick = (data: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.flatMap((key) => key in data ? [[key, data[key]]] : []))

/** What a client is shown of each journal kind; the kinds not here (prompts, tool input and output, usage) are skipped. */
const shown: Readonly<Record<string, (data: Readonly<Record<string, unknown>>) => Option.Option<Readonly<Record<string, unknown>>>>> = {
  "turn.started": (data) => Schema.decodeUnknownOption(Said)(data).pipe(Option.map((started) => ({ text: started.userMessage.text, ...pick(data, ["resumes"]) }))),
  "memory.message": (data) => Schema.decodeUnknownOption(Answered)(data).pipe(Option.flatMap((entry) => {
    const text = entry.body.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
    return text.length === 0 ? Option.none() : Option.some({ step: entry.step, text })
  })),
  "tool.completed": (data) => Option.some(pick(data, ["step", "invocationId", "tool", "ok"])),
  "tool.refused": (data) => Option.some(pick(data, ["step", "invocationId", "tool", "reason"])),
  "turn.reply": (data) => Schema.decodeUnknownOption(StoredReply)(data).pipe(Option.map((stored) => stored.body)),
  "turn.ended": (data) => Schema.decodeUnknownOption(TurnEndedData)(data).pipe(Option.map((ended) => ({
    reason: ended.reason, code: Option.getOrNull(Option.map(ended.failure, (failure) => failure.code)),
  }))),
}

/** The journal as a client sees it: each shown record with its turn, and the app's own `app.*` events as they are. */
export const clientProjection: FeedProjection = (record) => Effect.succeed(Option.map(
  record.kind.startsWith("app.") ? Option.some(record.data) : Option.flatMap(Option.fromNullishOr(shown[record.kind]), (show) => show(record.data)),
  (data): FeedPayload => ({ event: record.kind, data: { turn: record.turn ?? null, ...data } }),
))
// #endregion project

// #region turn-route
/** The status for each code a turn can fail to begin with; `satisfies` fails the build when `turnBeginCodes` gains one. */
const beginStatus = {
  [turnBeginCodes.AttachmentRejected]: 400, // an image the turn cannot take
  [turnBeginCodes.SessionBusy]: 409, // another turn is open: retry once it ends
  [turnBeginCodes.TurnDuplicate]: 409, // that key's turn is still running (an ended one is replayed)
  [turnBeginCodes.KeyConflict]: 409, // the key was begun with another message
  [turnBeginCodes.RunIdReused]: 409, // the run id names an earlier turn: each turn needs a new one
  [turnBeginCodes.NothingPending]: 204, // inbox turns only
  [turnBeginCodes.NotResumable]: 409, // `resumes` names a turn that cannot be resumed
  [turnBeginCodes.TurnRefused]: 429, // your TurnAdmission refused it (its reason may call for 403 or 503)
  [turnBeginCodes.SessionMissing]: 404,
  [turnBeginCodes.SessionContended]: 503, // other writers kept winning: retry later
  [turnBeginCodes.SessionLogError]: 503,
} satisfies Record<(typeof turnBeginCodes)[keyof typeof turnBeginCodes], number>

export const statusOf = (code: string): number =>
  Option.getOrElse(Option.fromNullishOr((beginStatus as Readonly<Record<string, number>>)[code]), () => 500)

export const problem = (status: number, code: string) =>
  status === 204 ? new Response(null, { status }) : Response.json({ code }, { status })

const TurnRequest = Schema.fromJsonString(Schema.Struct({ text: Schema.NonEmptyString, resumes: Schema.optional(Schema.Int) }))

/** A retried turn whose key has a turn already: that turn's stored answer once it ended, 409 while it runs. */
const replay = (host: Host, address: SessionAddress, key: Option.Option<string>) =>
  Option.match(key, { onNone: () => Effect.succeed(Option.none<StoredAnswer>()), onSome: (value) => storedAnswer(host.sessions, address, value) }).pipe(
    Effect.map(Option.match({ onNone: () => problem(409, turnBeginCodes.TurnDuplicate), onSome: (answer) => Response.json(answer) })))

/**
 * POST /sessions/:id/turns, `{ text, resumes? }` with an `Idempotency-Key`
 * header: the turn as SSE frames, `started` first and `done` last. A turn
 * that cannot begin is answered before anything streams: a retry by the
 * stored answer, a busy session with the turn it has open, any other
 * refusal with its code's status. `waitUntil` keeps the turn running after
 * the client leaves.
 */
export const turnRoute = (host: Host, owner: string, id: string, request: Request, waitUntil: (work: Promise<unknown>) => void): Promise<Response> =>
  Effect.runPromise(Effect.gen(function* () {
    const session = Schema.decodeUnknownOption(ConversationId)(id)
    if (Option.isNone(session)) return problem(404, turnBeginCodes.SessionMissing)
    const address = { id: session.value, owner }
    const body = yield* Effect.promise(() => request.text()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TurnRequest)))
    // The key the turn begins under, and a retry is answered by: the client's, else a resume's
    // `resume:<n>` (Agent.turn's own default). A turn with neither is keyed by its fresh run id.
    const key = Option.orElse(Option.fromNullishOr(request.headers.get("idempotency-key")),
      () => body.resumes === undefined ? Option.none<string>() : Option.some(`resume:${body.resumes}`))
    const head = yield* host.sessions.get(address) // its seq: where the client reads the journal from if the stream drops
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const push = yield* clientPush(writer)
    const started = yield* Deferred.make<void, TurnBeginError | TurnError>() // done by `use`, or failed as the turn did before it started
    const newTurn = {
      session: address, userMessage: new UserMessage({ text: body.text }), runId: RunId.make(crypto.randomUUID()),
      ...Option.match(key, { onNone: () => ({}), onSome: (value) => ({ key: value }) }),
      ...(body.resumes === undefined ? {} : { resumes: body.resumes }),
    }
    const run = Effect.gen(function* () {
      const exit = yield* Effect.exit(host.agent.turn({ turn: newTurn, services: Context.make(LanguageModel.LanguageModel, host.model) }, (turn) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(push({ event: "started", data: { turn: turn.turn, after: head.seq, resumes: turn.admitted.resumes ?? null } })),
          Effect.andThen(streamTo(push)(turn)))))
      if (yield* Deferred.done(started, Exit.asVoid(exit))) return // it never started: the route answers
      const ending = turnEndingOf(exit) // what the journal stores as the turn's `turn.ended`
      const code = Option.map(ending.failure, (failure) => failure.code)
      yield* push({ event: "done", data: { outcome: ending.reason, code: Option.getOrNull(code), usage: Exit.isSuccess(exit) ? exit.value.usage : null } })
    }).pipe(Effect.ensuring(closeStream(writer)))
    waitUntil(Effect.runPromise(run))
    return yield* Deferred.await(started).pipe(
      Effect.as(new Response(readable, { headers: sseHeaders })),
      // A refusal is the turn's failure as it is, its fields included: match the ones answered apart by tag.
      Effect.catchTags({
        TurnDuplicate: () => replay(host, address, key),
        SessionBusy: (busy) => Effect.succeed(Response.json({ code: turnBeginCodes.SessionBusy, turn: busy.turn }, { status: 409 })),
      }),
      // Any other failure before the turn started (another refusal, a defect, an interruption): the status for its code.
      Effect.catchCause((cause) => {
        const code = Option.match(turnEndingOf(Exit.failCause(cause)).failure, { onNone: () => "turn.failed", onSome: (failure) => failure.code })
        return Effect.succeed(problem(statusOf(code), code))
      }),
    )
  }).pipe(Effect.catchTags({
    SchemaError: () => Effect.succeed(problem(400, "request.invalid")),
    SessionMissing: () => Effect.succeed(problem(404, turnBeginCodes.SessionMissing)),
    SessionLogError: () => Effect.succeed(problem(503, turnBeginCodes.SessionLogError)),
  })))
// #endregion turn-route

// #region create-route
const CreateRequest = Schema.fromJsonString(Schema.Struct({ id: Schema.optional(ConversationId) }))

/**
 * POST /sessions, `{ id? }`: a new session, 201. A client that names the id
 * may retry: its own session again is 200, an id another owner holds is 409.
 */
export const createSessionRoute = (host: Host, owner: string, request: Request): Promise<Response> =>
  Effect.runPromise(Effect.gen(function* () {
    const { id } = yield* Effect.promise(() => request.text()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CreateRequest)))
    return yield* host.sessions.create({ owner, ...(id === undefined ? {} : { id }) }).pipe(
      Effect.map((view) => Response.json({ id: view.header.id }, { status: 201 })),
      Effect.catchTag("SessionExists", (exists) => host.sessions.get({ id: exists.session, owner }).pipe(
        Effect.map((view) => Response.json({ id: view.header.id }, { status: 200 })),
        Effect.catchTag("SessionMissing", () => Effect.succeed(problem(409, "session.exists"))))),
    )
  }).pipe(Effect.catchTags({
    SchemaError: () => Effect.succeed(problem(400, "request.invalid")),
    SessionLogError: () => Effect.succeed(problem(503, turnBeginCodes.SessionLogError)),
  })))
// #endregion create-route

// #region events-route
/**
 * An SSE peer over a Web stream: a write never fails, and `closed` completes
 * when the client leaves, or once a write has waited `timeout` on a client
 * that stopped reading: the stream is then aborted, and the feed stops.
 */
export const webSsePeer = (writer: WritableStreamDefaultWriter<Uint8Array>, signal: AbortSignal, timeout: Duration.Input = "2 seconds"): SsePeer => {
  const encoder = new TextEncoder()
  const stalled = new AbortController()
  const left = AbortSignal.any([signal, stalled.signal])
  return {
    write: (chunk) => writeWithin(writer, encoder.encode(chunk), timeout).pipe(Effect.flatMap((taken) => taken ? Effect.void : Effect.sync(() => {
      stalled.abort()
      return writer.abort().then(settle, settle)
    }))),
    closed: Effect.callback<void>((resume) => {
      const leave = () => resume(Effect.void)
      if (left.aborted) leave()
      left.addEventListener("abort", leave, { once: true })
      writer.closed.then(leave, leave) // the client cancelled the stream
    }),
  }
}

/** The client's cursor: `Last-Event-ID` (what EventSource sends when it reconnects), else `?after=`, else 0. */
const cursorOf = (request: Request): number => {
  const cursor = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? "0")
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
}

/**
 * GET /sessions/:id/events: the session's journal from the client's cursor
 * as SSE (`id: <seq>`, `event: <kind>`), polled, and woken by this
 * instance's own commits, until the feed's `maxDurationMs` or a client that
 * stopped reading is dropped; EventSource then reconnects with `Last-Event-ID`.
 */
export const eventsRoute = (host: Host, owner: string, id: string, request: Request, waitUntil: (work: Promise<unknown>) => void): Promise<Response> =>
  Effect.runPromise(Effect.gen(function* () {
    const session = Schema.decodeUnknownOption(ConversationId)(id)
    if (Option.isNone(session)) return problem(404, turnBeginCodes.SessionMissing)
    // Authorize before any header is written: a feed refused later still answers 200, and EventSource retries it forever.
    yield* host.sessions.get({ id: session.value, owner })
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const frames = host.feed.frames({ threadId: session.value, principalId: owner }, cursorOf(request), clientProjection)
    waitUntil(Effect.runPromise(SseTransport.serve(frames, webSsePeer(writer, request.signal)).pipe(Effect.ensuring(closeStream(writer)))))
    return new Response(readable, { headers: sseHeaders })
  }).pipe(Effect.catchTags({
    SessionMissing: () => Effect.succeed(problem(404, turnBeginCodes.SessionMissing)),
    SessionLogError: () => Effect.succeed(problem(503, turnBeginCodes.SessionLogError)),
  })))
// #endregion events-route

// #region ping
/** GET /ping: what this instance has in flight, for a load balancer, or a deploy waiting to stop it. */
export const pingRoute = (host: Host): Promise<Response> => Effect.runPromise(host.agent.activity.pipe(Effect.map((now) =>
  Response.json({ busy: now.busy, openTurns: now.openTurns.length, beginningTurns: now.beginningTurns, runningTasks: now.runningTasks }))))
// #endregion ping

/* ── test scaffolding: a scripted model, the host's tool, requests and frames ── */

type Part = Readonly<Record<string, unknown>>
const usage = { inputTokens: { total: 20 }, outputTokens: { total: 5 } }
const says = (text: string): ReadonlyArray<Part> => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const calls = (id: string, name: string, params: unknown): ReadonlyArray<Part> =>
  [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
/** A response as a streaming provider sends it: its text in two deltas. */
const asStream = (parts: ReadonlyArray<Part>): ReadonlyArray<Part> => parts.flatMap((part) => part.type === "text" && typeof part.text === "string"
  ? [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: part.text.slice(0, 3) }, { type: "text-delta", id: "t", delta: part.text.slice(3) }, { type: "text-end", id: "t" }]
  : [part])

/**
 * A provider answering the script's responses in order (then "done"),
 * streamed or not; with `streams: false` every stream fails before its first
 * part. Each call first waits for `hold`.
 */
const scripted = (script: ReadonlyArray<ReadonlyArray<Part>>, options: { readonly streams?: boolean; readonly hold?: Effect.Effect<void> } = {}) => Effect.gen(function* () {
  const count = yield* Ref.make(0)
  const next = (options.hold ?? Effect.void).pipe(Effect.andThen(Ref.getAndUpdate(count, (n) => n + 1)), Effect.map((n) => script[n] ?? says("done")))
  return yield* LanguageModel.make({
    generateText: () => next as never,
    streamText: () => (options.streams === false
      ? Stream.die("this provider does not stream")
      : Stream.unwrap(next.pipe(Effect.map((parts) => Stream.fromIterable(asStream(parts)))))) as never,
  })
})

const lookups = defineCapability({
  id: "events-guide", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed({ found: query.length }), annotations: { readOnly: true } })],
  skills: [defineSkill({ id: "lookup", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const owner = "user-1"
const sessionId = ConversationId.make("00000000-0000-4000-8000-0000000000e1")
const address: SessionAddress = { id: sessionId, owner }
const quickFeed = { pollMs: 10, maxPollMs: 40, heartbeatMs: 10_000, maxDurationMs: 5_000 }

/** A host over `log` (its own in-memory log by default) with the guide's tool, and its session created. */
const hostWith = (model: LanguageModel.LanguageModel, log: Layer.Layer<SessionLog> = SessionLogMemoryLive) => Effect.gen(function* () {
  const host = yield* makeHost({ log, model, capabilities: [lookups], feed: quickFeed })
  yield* host.sessions.create({ owner, id: sessionId })
  return host
})
const ask = (text: string, extra: { readonly resumes?: number } = {}) => ({
  turn: { session: address, userMessage: new UserMessage({ text }), runId: RunId.make(crypto.randomUUID()), ...extra },
})

/** The waitUntil of a test: the work it was handed, awaited at the end. */
const background = () => {
  const work: Array<Promise<unknown>> = []
  return { waitUntil: (promise: Promise<unknown>) => { work.push(promise) }, settled: Effect.promise(() => Promise.all(work)) }
}

const url = (path: string) => `http://localhost${path}`
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

/** The frames of a turn's stream (no ids): event and JSON data. */
const framesOf = (text: string): ReadonlyArray<{ readonly event: string; readonly data: Record<string, unknown> }> =>
  text.split("\n\n").filter((block) => block.startsWith("event: ")).map((block) => {
    const [event = "", data = "{}"] = block.split("\n").map((line) => line.slice(line.indexOf(": ") + 2))
    return { event, data: JSON.parse(data) as Record<string, unknown> }
  })

const decoder = new TextDecoder()
/** Read a stream until `done` says so, then stop. */
const readUntil = (reader: ReadableStreamDefaultReader<Uint8Array>, done: (text: string) => boolean, text = ""): Promise<string> =>
  done(text) ? Promise.resolve(text) : reader.read().then((chunk) => chunk.done ? text : readUntil(reader, done, text + decoder.decode(chunk.value, { stream: true })))

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

describe("streaming a turn to a client", () => {
  test("one background subscription gets every frame in order, and a step's text deltas spell its message", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([calls("c1", "lookup", { query: "alpha" }), says("Found five.")]))
    const { waitUntil, settled } = background()
    const response = yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(`/sessions/${sessionId}/turns`, { text: "find alpha" }), waitUntil))
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    const frames = framesOf(yield* Effect.promise(() => response.text()))
    yield* settled
    expect(frames.map((frame) => [frame.event, frame.data.state ?? frame.data.outcome ?? null])).toEqual([
      ["started", null],
      ["step", "started"], ["tool", "running"], ["tool", "done"], ["message", null], ["step", "completed"],
      ["step", "started"], ["delta", null], ["delta", null], ["message", null], ["step", "completed"],
      ["done", "completed"],
    ])
    expect(frames[0]?.data).toMatchObject({ turn: 1, after: 0, resumes: null })
    const deltas = frames.filter((frame) => frame.event === "delta" && frame.data.step === 1).map((frame) => frame.data.text).join("")
    expect(deltas).toBe("Found five.")
    expect(frames.find((frame) => frame.event === "message" && frame.data.step === 1)?.data.text).toBe(deltas)
    expect(frames.every((frame) => frame.event === "started" || frame.event === "done" || frame.data.turn === 1)).toBe(true)
    expect(frames.at(-1)?.data).toMatchObject({ code: null, usage: { inputTokens: 40, outputTokens: 10 } })
  })))

  test("a stream that fails before its first part: a fallback frame, no deltas, and the message still carries the text", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([says("Hello there.")], { streams: false }))
    const { waitUntil, settled } = background()
    const response = yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(`/sessions/${sessionId}/turns`, { text: "hi" }), waitUntil))
    const frames = framesOf(yield* Effect.promise(() => response.text()))
    yield* settled
    expect(frames.map((frame) => frame.event)).toEqual(["started", "step", "fallback", "message", "step", "done"])
    expect(frames.find((frame) => frame.event === "message")?.data.text).toBe("Hello there.")
    expect((yield* host.sessions.read(address, { kinds: ["stream.fallback"] })).map((event) => event.data.step)).toEqual([0])
  })))

  test("a client that stops reading never holds the turn: one write times out, the stream is aborted, the turn completes", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([calls("c1", "lookup", { query: "alpha" }), says("Found five.")]))
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>() // nobody reads it
    const push = yield* clientPush(writable.getWriter(), "200 millis")
    const started = Date.now()
    const result = yield* host.agent.turn({ ...ask("find alpha"), services: Context.make(LanguageModel.LanguageModel, host.model) }, streamTo(push))
    expect(result.outcome).toBe("completed")
    // Ten frames: if each waited out the timeout the turn would take 2 s; only the first does.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(yield* Effect.promise(() => readable.getReader().read().then(() => "open", () => "aborted"))).toBe("aborted")
  })))
})

describe("which subscription sees what", () => {
  test("the host's layer sees turn.started, use sees neither end, and only the outer scope sees turn.ended", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([]))
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const note = (line: string) => Ref.update(seen, (all) => [...all, line])
    const input = { ...ask("hello"), services: Context.make(LanguageModel.LanguageModel, host.model) }
    const inUse = yield* Ref.make<ReadonlyArray<string>>([])
    const reply = (turn: Turn) => turn.events.subscribe((event) => Option.some(event._tag), (tag) => Ref.update(inUse, (all) => [...all, tag])).pipe(
      Effect.andThen(turn.reply("Hello.")))
    // #region observe-usage
    const result = yield* Effect.scoped(Effect.gen(function* () {
      const outer = yield* Effect.scope // open until agent.turn has returned
      return yield* host.agent.turn({ ...input, layer: onTurnStarted((event) => note(`started ${event.turn}`)) }, (turn) =>
        onTurnEnded(outer, (event) => note(`ended ${event.outcome}: ${Option.getOrElse(event.reply, () => "")}`))(turn).pipe(
          Effect.andThen(reply(turn))))
    }))
    // #endregion observe-usage
    expect(result.outcome).toBe("completed")
    expect(yield* Ref.get(seen)).toEqual(["started 1", "ended completed: Hello."])
    expect((yield* Ref.get(inUse)).filter((tag) => tag === "turn.started" || tag === "turn.ended")).toEqual([])
  })))

  test("a failing turn still publishes turn.ended (outcome failed), and stores its error's code", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([]))
    const outcomes = yield* Ref.make<ReadonlyArray<string>>([])
    const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
      const outer = yield* Effect.scope
      return yield* host.agent.turn({ ...ask("hello"), services: Context.make(LanguageModel.LanguageModel, host.model) }, (turn) =>
        onTurnEnded(outer, (event) => Ref.update(outcomes, (all) => [...all, event.outcome]))(turn).pipe(
          Effect.andThen(Effect.fail(new HarnessError({ code: "app.unavailable", message: "the catalogue is down" })))))
    })))
    expect(Exit.isFailure(exit) ? turnEndingOf(exit).failure.pipe(Option.map((failure) => failure.code), Option.getOrNull) : "none").toBe("app.unavailable")
    expect(yield* Ref.get(outcomes)).toEqual(["failed"])
    expect(yield* endingsOf(host.sessions, address)).toEqual([{ turn: 1, reason: "failed", code: "app.unavailable" }])
  })))
})

describe("tools and host events", () => {
  test("onTool sees lookup's calls; a call the host's ActionPolicy denies is tool.refused and a not-ok result in step.ended", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([calls("c1", "lookup", { query: "alpha" }), says("ok"), calls("c2", "lookup", { query: "beta" }), says("ok")]))
    const lines = yield* Ref.make<ReadonlyArray<string>>([])
    const report = (line: string) => Ref.update(lines, (all) => [...all, line])
    const use = (turn: Turn) => watchTools(turn, report).pipe(Effect.andThen(streamTo(() => Effect.void)(turn)))
    yield* host.agent.turn({ ...ask("find alpha"), services: Context.make(LanguageModel.LanguageModel, host.model) }, use)
    const denying = Context.make(ActionPolicy, { authorize: (tool) => tool === "lookup" ? Effect.fail(new HarnessError({ code: "policy.denied", message: "not for this user" })) : Effect.void })
    yield* host.agent.turn({ ...ask("find beta"), services: Context.merge(Context.make(LanguageModel.LanguageModel, host.model), denying) }, use)
    expect(yield* Ref.get(lines)).toEqual([
      "lookup \"alpha\" found 5",
      "lookup refused (denied): not for this user",
      "step 0: not ok lookup",
    ])
    const refused = yield* host.sessions.read(address, { kinds: ["tool.refused"] })
    expect(refused.map((event) => [event.data.tool, event.data.reason, "input" in event.data])).toEqual([["lookup", "denied", false]])
  })))

  test("a host event is journaled under its name; a reserved name fails its publish with events.reserved", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([]))
    const code = yield* Ref.make("")
    yield* host.agent.turn({ ...ask("hello"), services: Context.make(LanguageModel.LanguageModel, host.model) }, (turn) => Effect.gen(function* () {
      yield* reportStage(turn.events, "search", 1)
      // #region reserved
      const Clash = defineHostEvent("tool.progress", Schema.Struct({ text: Schema.String })) // a bus event's name
      const published = yield* Clash.publish(turn.events, { text: "50%" }).pipe(
        Effect.match({ onFailure: (error) => Option.getOrElse(harnessCodeOf(error), () => error._tag), onSuccess: () => "published" })) // "events.reserved"
      // #endregion reserved
      yield* Ref.set(code, published)
      return yield* turn.reply("Done.")
    }))
    expect(yield* Ref.get(code)).toBe("events.reserved")
    const stored = yield* host.sessions.read(address)
    expect(stored.filter((event) => event.kind === "app.progress").map((event) => event.data)).toEqual([{ stage: "search", done: 1 }])
    expect(stored.some((event) => event.kind === "tool.progress")).toBe(false)
  })))
})

describe("the journal", () => {
  test("a second instance over the same log follows a turn the first runs, by polling, and readAfter pages by seq", () => run(Effect.gen(function* () {
    const shared = Layer.succeedContext(yield* Layer.build(SessionLogMemoryLive))
    const model = yield* scripted([says("Hello there.")])
    const writerHost = yield* hostWith(model, shared)
    const readerHost = yield* makeHost({ log: shared, model, feed: quickFeed }) // another process, in effect: its own Sessions
    const { waitUntil, settled } = background()
    // The reader follows the session before the turn begins. Its own Sessions commits nothing, so
    // its feed is never woken: every record of the writer's turn reaches it by polling.
    const controller = new AbortController()
    const feed = yield* Effect.promise(() => eventsRoute(readerHost, owner, sessionId, new Request(url(`/sessions/${sessionId}/events`), { signal: controller.signal }), waitUntil))
    const reader = feed.body!.getReader()
    const backlog = yield* Effect.promise(() => readUntil(reader, (seen) => seen.includes("event: ready")))
    const following = readUntil(reader, (seen) => seen.includes("event: turn.ended"), backlog) // read on, as a browser does
    const turn = yield* Effect.promise(() => turnRoute(writerHost, owner, sessionId, post(`/sessions/${sessionId}/turns`, { text: "hi" }), waitUntil))
    yield* Effect.promise(() => turn.text())
    const text = yield* Effect.promise(() => following)
    controller.abort()
    yield* settled
    expect((yield* Effect.fromResult(decodeSse(text))).map((frame) => frame._tag === "FeedRecord" ? frame.event : frame._tag)).toEqual(["FeedReady", "turn.started", "memory.message", "turn.reply", "turn.ended"])
    const page = yield* readAfter(readerHost.sessions, address, 0)
    expect(page.events.map((event) => event.seq)).toEqual(page.events.map((_, index) => index + 1))
    expect((yield* readAfter(readerHost.sessions, address, page.cursor)).events).toEqual([])
  })))
})

describe("serving turns over HTTP", () => {
  test("creating a session: 201, the same id again 200, another owner's id 409", () => run(Effect.gen(function* () {
    const host = yield* makeHost({ log: SessionLogMemoryLive, model: yield* scripted([]) })
    const id = "00000000-0000-4000-8000-0000000000e2"
    const statuses = yield* Effect.promise(() => Promise.all([
      createSessionRoute(host, owner, post("/sessions", { id })),
      createSessionRoute(host, owner, post("/sessions", { id })),
      createSessionRoute(host, "someone-else", post("/sessions", { id })),
      createSessionRoute(host, owner, post("/sessions", { id: "not-an-id" })),
    ]).then((responses) => Promise.all(responses.map((response) => response.json().then((body) => [response.status, body])))))
    expect(statuses).toEqual([[201, { id }], [200, { id }], [409, { code: "session.exists" }], [400, { code: "request.invalid" }]])
  })))

  test("begin codes as statuses: a retry gets the stored answer, another message under its key 409, an unknown session 404", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([says("Hello there.")]))
    const { waitUntil, settled } = background()
    const turns = `/sessions/${sessionId}/turns`
    const first = yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(turns, { text: "hi" }, { "idempotency-key": "k-1" }), waitUntil))
    yield* Effect.promise(() => first.text())
    yield* settled
    const answers = yield* Effect.promise(() => Promise.all([
      turnRoute(host, owner, sessionId, post(turns, { text: "hi" }, { "idempotency-key": "k-1" }), waitUntil),
      turnRoute(host, owner, sessionId, post(turns, { text: "something else" }, { "idempotency-key": "k-1" }), waitUntil),
      turnRoute(host, "someone-else", sessionId, post(turns, { text: "hi" }), waitUntil),
      turnRoute(host, owner, "not-an-id", post(turns, { text: "hi" }), waitUntil),
      turnRoute(host, owner, sessionId, post(turns, { text: "" }), waitUntil),
    ]).then((responses) => Promise.all(responses.map((response) => response.json().then((body) => [response.status, body])))))
    yield* settled
    expect(answers).toEqual([
      [200, { turn: 1, reason: "completed", reply: "Hello there." }],
      [409, { code: "turn.key-conflict" }],
      [404, { code: "session.missing" }],
      [404, { code: "session.missing" }],
      [400, { code: "request.invalid" }],
    ])
  })))

  test("while a turn runs: another is 409 session.busy naming the open turn, its own retry 409 turn.duplicate, and /ping and awaitIdle say busy until it ends", () => run(Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const host = yield* hostWith(yield* scripted([says("Slow.")], { hold: Deferred.await(release) }))
    const { waitUntil, settled } = background()
    const turns = `/sessions/${sessionId}/turns`
    const first = yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(turns, { text: "slow" }, { "idempotency-key": "k-1" }), waitUntil))
    const refused = yield* Effect.promise(() => Promise.all([
      turnRoute(host, owner, sessionId, post(turns, { text: "again" }), waitUntil),
      turnRoute(host, owner, sessionId, post(turns, { text: "slow" }, { "idempotency-key": "k-1" }), waitUntil),
    ]).then((responses) => Promise.all(responses.map((response) => response.json().then((body) => [response.status, body])))))
    expect(refused).toEqual([[409, { code: "session.busy", turn: 1 }], [409, { code: "turn.duplicate" }]])
    expect(yield* Effect.promise(() => pingRoute(host).then((response) => response.json()))).toMatchObject({ busy: true, openTurns: 1 })
    expect((yield* awaitIdle({ timeout: "20 millis" }).pipe(Effect.provide(host.services))).busy).toBe(true)
    yield* Deferred.succeed(release, undefined)
    expect(framesOf(yield* Effect.promise(() => first.text())).at(-1)?.data.outcome).toBe("completed")
    yield* settled
    expect(yield* Effect.promise(() => pingRoute(host).then((response) => response.json()))).toEqual({ busy: false, openTurns: 0, beginningTurns: 0, runningTasks: 0 })
    expect(yield* awaitIdle({ timeout: "1 second" }).pipe(Effect.provide(host.services))).toEqual({ busy: false, openTurns: [], beginningTurns: 0, runningTasks: 0 })
  })))

  test("a cancelled turn is resumed, a keyless retry of the resume gets its stored answer, resuming it again under another key is 409 turn.not-resumable", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([says("Resumed.")]))
    yield* Effect.scoped(host.sessions.begin(address, { _tag: "User", userMessage: new UserMessage({ text: "find alpha" }), runId: RunId.make("run-1"), key: "k-1", command: {} }).pipe(
      Effect.andThen(host.sessions.cancel(address, 1))))
    const { waitUntil, settled } = background()
    const turns = `/sessions/${sessionId}/turns`
    const resumed = yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(turns, { text: "Continue.", resumes: 1 }), waitUntil))
    const frames = framesOf(yield* Effect.promise(() => resumed.text()))
    yield* settled
    expect(frames[0]?.data).toMatchObject({ turn: 2, resumes: 1 })
    expect(frames.at(-1)?.data.outcome).toBe("completed")
    const retried = yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(turns, { text: "Continue.", resumes: 1 }), waitUntil))
    expect([retried.status, yield* Effect.promise(() => retried.json())]).toEqual([200, { turn: 2, reason: "completed", reply: "Resumed." }])
    const again = yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(turns, { text: "Continue.", resumes: 1 }, { "idempotency-key": "k-3" }), waitUntil))
    yield* settled
    expect([again.status, yield* Effect.promise(() => again.json())]).toEqual([409, { code: "turn.not-resumable" }])
  })))

  test("the journal over SSE: ids are seqs, Last-Event-ID resumes after one, prompts never leave, another owner is 404", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([calls("c1", "lookup", { query: "alpha" }), says("Found five.")]))
    const { waitUntil, settled } = background()
    const events = `/sessions/${sessionId}/events`
    yield* Effect.promise(() => turnRoute(host, owner, sessionId, post(`/sessions/${sessionId}/turns`, { text: "find alpha" }), waitUntil).then((response) => response.text()))
    const follow = (headers: Record<string, string>) => Effect.gen(function* () {
      const controller = new AbortController()
      const response = yield* Effect.promise(() => eventsRoute(host, owner, sessionId, new Request(url(events), { headers, signal: controller.signal }), waitUntil))
      const text = yield* Effect.promise(() => readUntil(response.body!.getReader(), (seen) => seen.includes("event: ready")))
      controller.abort()
      return (yield* Effect.fromResult(decodeSse(text))).flatMap((frame) => frame._tag === "FeedRecord" ? [frame] : [])
    })
    const all = yield* follow({})
    expect(all.map((frame) => frame.event)).toEqual(["turn.started", "tool.completed", "memory.message", "turn.reply", "turn.ended"])
    expect(all.map((frame) => frame.data)).toEqual([
      { turn: 1, text: "find alpha" },
      { turn: 1, step: 0, invocationId: expect.any(String), tool: "lookup", ok: true },
      { turn: 1, step: 1, text: "Found five." },
      { turn: 1, outcome: "completed", reply: "Found five." },
      { turn: 1, reason: "completed", code: null },
    ])
    const stored = yield* host.sessions.read(address)
    // Each frame's id is its record's seq; the records the projection skips advance the cursor all the same.
    expect(all.every((frame) => stored.some((event) => event.seq === frame.sequence && event.kind === frame.event))).toBe(true)
    expect(all.map((frame) => frame.sequence)).toEqual(all.map((frame) => frame.sequence).toSorted((a, b) => a - b))
    const reply = all.find((frame) => frame.event === "turn.reply")?.sequence ?? 0
    expect((yield* follow({ "last-event-id": String(reply) })).map((frame) => frame.event)).toEqual(["turn.ended"])
    const stranger = yield* Effect.promise(() => eventsRoute(host, "someone-else", sessionId, new Request(url(events)), waitUntil))
    expect([stranger.status, stranger.headers.get("content-type")?.startsWith("application/json")]).toEqual([404, true])
    yield* settled
  })))

  test("a journal follower that stops reading is dropped: its first write times out, the stream is aborted, the feed stops", () => run(Effect.gen(function* () {
    const host = yield* hostWith(yield* scripted([]))
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>() // nobody reads it
    const started = Date.now()
    const frames = host.feed.frames({ threadId: sessionId, principalId: owner }, 0, clientProjection)
    yield* SseTransport.serve(frames, webSsePeer(writable.getWriter(), new AbortController().signal, "50 millis"))
    // Unbounded, the first write would wait as long as the client stays connected: the feed checks maxDurationMs only between polls.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(yield* Effect.promise(() => readable.getReader().read().then(() => "open", () => "aborted"))).toBe("aborted")
  })))
})

describe("the guide's begin codes", () => {
  test("every code Agent.turn can fail to begin with has a status", () => {
    expect(Object.values(turnBeginCodes).map(statusOf).every((status) => status !== 500)).toBe(true)
    expect(statusOf("loop.failed")).toBe(500)
  })
})
