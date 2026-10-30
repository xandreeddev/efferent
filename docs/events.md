# Events guide

How a host uses efferent's events: stream a turn to a client, react to its
tools, see a turn start and end, publish its own events, follow a session
from another request or process, and serve all of it over HTTP. The
[event reference](event-reference.md) lists every event's payload, who
publishes it and how it is stored; this guide is about using them.

Every code block below, except the Next.js glue at the end, is a region of
[`events-guide.test.ts`](../packages/sdk/src/events-guide.test.ts), a test
that runs key-free with a scripted model. `bun run docs:generate` copies each
region here with the imports it uses, and `bun run verify:packages` runs the
HTTP recipe against the packed packages on Node and on Bun.

## Two kinds of events

| | The bus (`TurnEvents`) | The journal (`SessionLog`, read through `Sessions`) |
| --- | --- | --- |
| What | One turn's typed events (`TurnEvent`), as they happen | The session's durable log: `{ session, seq, turn, kind, at, data }`, `seq` dense from 1 |
| Where and when | In the process running the turn, while it runs | Anywhere that reaches the same `SessionLog`, at any time |
| Who sees it | Subscriptions on the turn's bus: in `use`, the host's per-turn layer, session plugins, tools (`RunContext.events`) | `Sessions.read` from a cursor; plugin-render's journal feed |
| Token deltas, tool output as it streams | Yes: `assistant.delta` and `tool.progress`, both transient | Never |
| Payloads | Whole: the tool's decoded input and result, the message text, the usage | Reduced: `tool.completed` without input and result, `tool.refused` without input, `assistant.message` as `step.usage`; the text is in `memory.message` |
| Can change the turn | Yes: an inline handler runs before `publish` returns, so the next step and the completion policy see what it did | No: reads never write |
| A failing handler | Fails the turn | Not applicable |

The two are joined by the turn's writer, the bus's first subscriber: every
event that is not transient is queued for the journal under its own name, a
host event under its `name`, before any of your handlers runs. Three bus
events are not copied: the session stores its own `turn.started` when the
turn begins and its own `turn.ended` (`reason`, `failure`) when it ends,
memory stores the reply as `turn.reply` and skill activations as
`memory.skills`.

Use the bus for what the process running the turn shows or decides now:
tokens and tool activity for the user who asked, reactions that steer the
turn, in-process metrics. Use the journal for everything else: a browser
that reconnects or opens the conversation later, another instance, an audit
trail, an export.

## Streaming a turn to a client

Forward the bus through one background subscription. A background
subscription has its own bounded queue and fiber: `publish` returns once
the event is queued, so writing to a slow client stays off the step loop's
path, and the handler sees events in the order they were published. Two
subscriptions are two queues and two fibers, which can reach the client in
a different order: one subscription for everything a client sees keeps one
ordered lane.

First, which events a client is shown, and how:

<!-- snippet: packages/sdk/src/events-guide.test.ts#progress -->
```ts
import { Match, Option } from "effect"
import type { TurnEvent } from "@xandreed/sdk"

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
```

Then `use`, the turn's body, for a streamed turn:

<!-- snippet: packages/sdk/src/events-guide.test.ts#stream -->
```ts
import { Effect, Option, Scope } from "effect"
import type { Turn, TurnError, TurnOutcome } from "@xandreed/sdk"

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
```

What the frames mean:

- `assistant.delta` is published for each increment of a streamed response,
  on channel `text`, `reasoning` or `tool-params`; `id` groups the
  increments of one content part. A step's `text` deltas, concatenated, are
  its `assistant.message.text`. A `tool-params` part starts with an empty
  delta, and its `id` is the provider's id for the call (the one
  `assistant.message.toolCalls` and `step.ended.results` carry as well).
- `assistant.message` is published once per provider response, after the
  step's tools have run: it restates the step's text. Replace the step's
  deltas with it. Its `finishReason` says why the response ended: `stop`,
  `tool-calls` and `pause` are whole; `length` (the output limit),
  `content-filter`, `error` and `other` cut it short, and so does
  `unknown` (no finish reason given) when the response holds tool calls
  the loop would run. A cut response ran none of its tool calls, and its
  step ends `truncated`. A step that ends `malformed` (`step.ended.status`)
  has no `assistant.message`: the model could not form its response (a
  tool that does not exist, parameters that do not decode), and the loop
  answered it with a correction, so drop that step's deltas.
- `stream.fallback`: the provider's stream failed before its first part.
  The step, and every later step of the run, is answered without
  streaming: no more deltas, and the text arrives with `assistant.message`.
  It is journaled too.
- `tool.progress` is what a tool reports while it runs (`publishToolProgress`
  in its handler): `stdout` and `stderr` for a command's output as it
  arrives, `status` for anything else. It shares its call's `invocationId`
  with that call's `tool.started` and `tool.completed`, and is never
  journaled. The frames above show only `status`.

Streaming is on unless the run's `limits.streaming` turns it off. A stalled
or slow client must not stall the turn: see the next section.

## Handlers must not fail or block

A handler is part of the turn:

- An inline handler that fails fails the turn with its own error, and the
  stored `turn.ended` carries that error's code. One that fails on an event
  of a tool call (`tool.started`, `tool.progress`, `tool.completed`, or what
  the tool's handler publishes) fails the turn, never the call: the model
  does not get it as the tool's result, and on `tool.started` or
  `tool.progress` the tool's handler stops there.
- A background handler that fails is latched: the next delivery to it fails,
  and so does the drain before the reply is recorded, which fails the turn.
  A handler that dies with a defect fails it with that defect (stored as
  `turn.defect`, its message without the stack); one that is interrupted
  fails it with `events.background`.
- A background queue holds 256 events unless the subscription's `capacity`
  says otherwise. When it is full, `publish` waits: a slow handler slows the
  step loop. A background handler's own publications never wait, to its own
  subscription or another's: they are queued past the capacity, so a
  handler that publishes what it takes cannot deadlock. A publisher waiting
  for room can always be interrupted.
- On success the turn drains every background subscription before it
  records its reply. A handler that never returns keeps the reply from being
  recorded, and the turn holds its session until it is cancelled or its
  process stops. A cancelled turn does not wait for its handlers: it records
  its failed reply and ends at once. A turn that failed waits ten seconds at
  most for the reactions to its failed reply.

So a push to a client never fails and is bounded in time. Once a write has
waited too long, the client is gone for the rest of the turn: the stream is
aborted, and later frames are dropped at once instead of each waiting out
the timeout. Nothing waits on that stream again: aborted while a write
still waits, it settles neither that write nor its close until the client
reads again or leaves, so `closeStream` ends a stream without waiting.

<!-- snippet: packages/sdk/src/events-guide.test.ts#push -->
```ts
import { Duration, Effect, Option, Ref } from "effect"

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
```

## Which subscription sees what

A subscription lives as long as the scope it was made in. `Agent.turn`
closes the turn's scopes in order: `use`'s, then the host's per-turn
`layer`, then the session plugins that need the turn's services, and only
then records the reply and publishes `turn.ended`.

| Subscribed in | Sees `turn.started` | Sees `turn.ended` |
| --- | --- | --- |
| `use` (`turn.events.subscribe`, `onEvent`, `onTool`, a host event's `on`) | No: it is published before `use` runs | No: `use`'s scope has closed |
| The host's per-turn `layer`, or a session plugin that needs the turn's services (`yield* TurnEvents`) | Yes | No |
| A scope that outlives the turn (`Scope.provide(outer)`) | Only if made in the layer | Yes |
| A host composing the turn itself, around `TurnLive` | Yes | Yes |

<!-- snippet: packages/sdk/src/events-guide.test.ts#observe -->
```ts
import { Effect, Layer, Option, Scope } from "effect"
import { TurnEvents } from "@xandreed/sdk"
import type { Turn, TurnEventOf } from "@xandreed/sdk"

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
```

In use: `outer` is held open by the caller until `agent.turn` has
returned; `host` is the one built [below](#serving-turns-over-http), `input`
the turn's input, `note` the host's logger and `reply(turn)` the turn's body:

<!-- snippet: packages/sdk/src/events-guide.test.ts#observe-usage -->
```ts
import { Effect, Option } from "effect"

const result = yield* Effect.scoped(Effect.gen(function* () {
  const outer = yield* Effect.scope // open until agent.turn has returned
  return yield* host.agent.turn({ ...input, layer: onTurnStarted((event) => note(`started ${event.turn}`)) }, (turn) =>
    onTurnEnded(outer, (event) => note(`ended ${event.outcome}: ${Option.getOrElse(event.reply, () => "")}`))(turn).pipe(
      Effect.andThen(reply(turn))))
}))
```

What settles, and when:

- On success, before the reply is recorded, the turn joins its tasks
  (`turn.tasks.fork`) and drains its background subscriptions, at each scope
  it closes: everything they queued is handled, and what their finalizers
  publish or fork as well.
- On failure or interruption, tasks are interrupted, and deliveries still
  queued for `use`'s background subscriptions can be lost. Take the outcome
  from `agent.turn` (or the stored `turn.ended`), not from the last frame a
  handler saw.
- `turn.ended` (`outcome`, `reply`, `usage`) is published once the reply is
  recorded, also when the turn failed (outcome `failed`), but only once
  memory has taken the user's message: a turn that could not begin, or whose
  plugins or layer failed to build, publishes none. Handle `agent.turn`'s
  result as well.
- A `turn.ended` handler runs after the turn's own scopes have closed: it may
  use only what is still open in the caller's scope. It must not fail: on a
  turn that succeeded, its failure fails the turn, and the reply, held for
  the turn's end, is stored as failed (its text kept). The stored reply is
  written with the turn's `turn.ended`, in one commit: a handler that reads
  the journal does not find it yet.

## Tools: results, refusals and progress

- `onTool(tool, handle)` reacts to one tool's successful calls, its input
  and result typed by the tool's own schemas (checked with `Schema.is`,
  never cast).
- `tool.completed` with `ok: false`: the handler ran and failed, and the
  model got the failure as the call's result.
- `tool.refused`: the registry refused the call before its handler ran,
  and published no `tool.started` or `tool.completed` for it. `reason` is
  `inactive`, `forbidden` (a permission the turn lacks), `denied` (the
  host's `ActionPolicy`), `call-limit` or `tool-call-limit`; `message` is
  what the model got as the call's result, as `{ error, message }` under a
  name of its own (`ToolInactive`, `PermissionDenied`, `PolicyDenied`,
  `CallLimit`, `ToolCallLimit`): match on `reason`, not on that name.
- `step.ended.results` lists the step's recorded tool results (memory entry,
  call id, tool, `ok`), refused calls included as not ok: one place to see
  every call the registry handled that did not succeed.
- In a whole response, a call to a tool that does not exist, or whose
  parameters do not decode, never reaches the registry: no tool event, and
  no entry in `step.ended.results`. The response is malformed and none of
  its calls runs, the others included: its step ends `malformed`, without
  `assistant.message` or `completion.evaluated`, the loop's correction is
  recorded as a `memory.message` (a user message) under the next step, and
  the model is asked again; at the step cap the run ends `partial` instead,
  and no correction is recorded.
- A call in a response cut short (its `assistant.message.finishReason`
  cuts it, as above), whatever its tool and parameters, never reaches the
  registry either: no tool event. Its result, which the model reads, is
  the failure `{ error: "ReplyCut", message }` (the message says how the
  reply ended and that this call was not run), listed in
  `step.ended.results` as not ok; the step ends `truncated`, without
  `completion.evaluated`.

<!-- snippet: packages/sdk/src/events-guide.test.ts#tools -->
```ts
import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { Failure, onEvent, onTool, subscribeAll } from "@xandreed/sdk"
import type { Turn } from "@xandreed/sdk"

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
```

A tool reports progress with `publishToolProgress(channel, text)` from its
handler; outside a tool call it does nothing. Images are journaled
inline, as base64: the user's in the session's `turn.started`, and a
tool's in its `memory.tool-result` (the encoded output) and in the
`tool.completed` result on the bus. See
[Images and multi-part messages](framework.md#images-and-multi-part-messages)
for what the model is sent, and keep them out of what a client is shown
unless it needs them (`elideMediaData` from `@xandreed/core` replaces each
image's base64 with its fingerprint).

## Your own events

`defineHostEvent(name, schema)` gives an application event of its own,
typed by its schema. The turn's writer journals it under its `name`, so the
session's followers see it with nothing more to write.

<!-- snippet: packages/sdk/src/events-guide.test.ts#host-events -->
```ts
import { Schema } from "effect"
import { defineHostEvent } from "@xandreed/sdk"
import type { TurnEventsService } from "@xandreed/sdk"

/** The application's own event: typed by its schema, journaled under its name, seen by the session's followers. */
export const Progress = defineHostEvent("app.progress", Schema.Struct({ stage: Schema.String, done: Schema.Number }))

/** Publish it from `use` (`turn.events`), a task, a tool (`RunContext.events`) or a session plugin (`TurnEvents`). */
export const reportStage = (events: TurnEventsService, stage: string, done: number) => Progress.publish(events, { stage, done })
```

- A host event may not take a [reserved name](event-reference.md#reserved-kinds)
  (`RESERVED_KINDS`): a kind core or the sessions plugin writes (memory's
  kinds, the bus events the writer stores, `turn.ended`, `inbox.queued`,
  `inbox.dropped`) or any bus event's name, matched exactly. Its publish
  fails with `events.reserved`, and so does the turn unless the caller
  handles it. A record appended through the turn's writer
  (`TurnWriter.append` or `transact`) under one of those names is refused
  with `ReservedKind` (whose code is `events.reserved`), and nothing of that
  call is stored: only the framework's turn writes them.
- Nothing else is refused: other names in those namespaces, and the kinds a
  plugin records for itself, are accepted. Never use them: plugin-tasks
  reads the first `task.result` or `task.cancelled` in a task's child
  session as the task's outcome, so a host event under one of those names
  there would be taken for it. Use your own namespace (`app.*`).
- The published `data` is the encoded payload as JSON (`undefined` fields
  are dropped). A payload that does not encode, or whose encoded form JSON
  cannot hold (a BigInt), fails with `events.encode`; one a subscriber
  cannot decode is skipped by `select` and `on`.
- Handlers may publish in turn, depth first, up to `maxEventDepth` (8, set
  on the agent); deeper fails with `events.depth`.

<!-- snippet: packages/sdk/src/events-guide.test.ts#reserved -->
```ts
import { Effect, Option, Schema } from "effect"
import { defineHostEvent, harnessCodeOf } from "@xandreed/sdk"

const Clash = defineHostEvent("tool.progress", Schema.Struct({ text: Schema.String })) // a bus event's name
const published = yield* Clash.publish(turn.events, { text: "50%" }).pipe(
  Effect.match({ onFailure: (error) => Option.getOrElse(harnessCodeOf(error), () => error._tag), onSuccess: () => "published" })) // "events.reserved"
```

## Reading the journal

`Sessions.read(address, { after, kinds, limit })` returns a session's
events after a cursor, `seq` order. Reads never write: following a session
runs nothing. An address whose owner is not the session's finds nothing
(`SessionMissing`). `Sessions.get(address)` is the session's view: `seq`,
the cursor of its last event, and `open`, the turn it has open, if any.

<!-- snippet: packages/sdk/src/events-guide.test.ts#journal -->
```ts
import { Effect, Option, Schema } from "effect"
import { Sessions, turnEndedOf } from "@xandreed/sdk"
import type { SessionAddress } from "@xandreed/sdk"

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
```

Across requests, instances and processes:

- Every reader needs the same `SessionLog` the writer commits to.
  `SessionLogMemoryLive` is one process's memory, and `SessionLogSqliteLive`
  (`@xandreed/plugin-session-sqlite`) a file on Bun; anything else is your
  own store over your database, checked with `sessionLogConformance` and
  `sessionLogRecoveryConformance` (see [the sessions
  section](framework.md#sessions-one-log-per-session)).
- `Sessions.changes(address)` signals only the commits made through that
  `Sessions` instance, to that session's followers. A signal means "read
  again": the signals a follower has not taken merge into one, so count
  reads, never signals. Everyone else polls `read` from their cursor;
  plugin-render's journal feed does both (it wakes on `changes`, and polls
  every 200 ms to 1 s otherwise).
- The writer stores what a turn queues behind it: a process that dies loses
  what it had queued but not yet committed. `turn.flush` waits until
  everything queued so far is stored.
- A turn whose process died stays open until its lease runs out (`open`
  then reads none), and has no `turn.ended` until a later `begin`, `cancel`,
  `deliver` or `drain` on that session reaps it, as interrupted with the code
  `turn.lease`. A follower waiting for `turn.ended` also watches
  `Sessions.get(address).open`.
- A turn whose end the store refused, even at its scope's close, is logged
  (with `efferent.session.id` and `efferent.turn`) and let go of by its
  instance: it reads closed there at once, and is reaped the same way,
  without waiting for its lease or for its process to exit.

## How a turn ended

Three places say how a turn ended; two of them carry the failure's code:

- `agent.turn`'s result: a `TurnResult` (`outcome`, `reply`, `usage`, and,
  for a turn it began, `pending`: the inbox items its end left waiting, a
  background task's result delivered meanwhile, which you drain), or a
  failure with a `HarnessError` whose `code` says why.
- The stored `turn.ended`: `reason` (completed, partial, failed, cancelled,
  interrupted) and `failure`, `{ code, message }`. A turn that `Agent.turn`
  began ends with `turnEndingOf` its exit: the failing error's own code
  (a subscriber's, a plugin's, yours), else `turn.failed`, `turn.defect` or
  `turn.interrupted`. A turn its writer's scope closed before anyone ended it
  stores `turn.unended`, and a reaped one `turn.lease`. The
  [event reference](event-reference.md#error-codes) lists them.
- The live `turn.ended`: `outcome` (completed, partial or failed), `reply`
  and `usage`, no code.

## Resuming, leases and the busy signal

- **Resume.** A turn that was cancelled or interrupted (its client went,
  its process stopped) can be continued by the next user's turn:
  `turn: { session, userMessage, runId, resumes: n }`. Its `turn.started`,
  on the bus and in the journal, carries `resumes`; a turn that cannot be
  resumed fails to begin with `NotResumable` (`turn.not-resumable`).
  Without a key of its own, a resume is keyed `resume:<n>`, so a retry is
  `TurnDuplicate` (`turn.duplicate`; the turn route below answers it from
  the journal). Every turn needs a run id of its own: one an earlier turn
  of the session was begun with fails to begin with `RunIdReused`
  (`turn.run-reused`). See
  [resuming a turn](framework.md#resuming-a-turn).
- **Leases.** By default a turn's lease is 60 s, renewed by its writes and by
  a keep-alive every 20 s while it runs, so a step that writes nothing for
  minutes (a long model call, a slow tool) keeps its turn. Keep lease
  ownership when several instances share the log, as on a serverless
  platform.
- **Busy.** `agent.activity` says what this process has in flight (open
  turns, turns beginning, background tasks) and whether it is stopping,
  which the ping below answers with a 503. `awaitIdle({ timeout })` waits
  for nothing to be in flight, for a graceful shutdown. It reads the
  activity probes from the services it runs with, and without them finds
  none and reports idle at once: with the host
  [below](#serving-turns-over-http), run
  `awaitIdle({ timeout }).pipe(Effect.provide(host.services))`.
  `agent.shutdown()` stops the turns within a deadline: new turns are
  refused (`TurnRefused`, reason `shutdown`), those still running at the
  deadline end interrupted with `turn.shutdown`, resumable. See [busy
  signal and graceful shutdown](framework.md#busy-signal-and-graceful-shutdown)
  for the whole shutdown.
- **Time limit.** A turn may run 6 hours by default (`turns.timeLimitMs`
  of the sessions plugin), or the `timeLimitMs` its begin gives; past it,
  it is stored as interrupted with `turn.time-limit` (resumable) and
  `Agent.turn` fails with `TurnClosed` of reason `timed-out`.
- **Traces.** Every turn `Agent.turn` runs is an `agent.turn` span carrying
  the session, run and turn ids (see [traces and
  metrics](framework.md#traces-and-metrics)).

## Serving turns over HTTP

The handlers below take a Fetch API `Request` and return a `Response`, so
they run as they are in a Next.js App Router route, under `Bun.serve`, or
in any server that speaks the Fetch API. They are built from what the
sections above showed: the stream, the bounded push, the journal and
plugin-render's feed. A server without the Fetch API serves the journal
the same way with plugin-render's `sseNodePeer` over a Node response.

One host per server instance, over a session log every instance shares:

<!-- snippet: packages/sdk/src/events-guide.test.ts#host -->
```ts
import { Context, Effect, Layer, Scope } from "effect"
import { LanguageModel } from "effect/ai"
import { Agent, Sessions, TurnAdmissionOpen } from "@xandreed/sdk"
import type { Capability, SessionLog } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { RenderFeed, RenderFeedLive, renderFeedDefaults, SessionsJournalTailLive } from "@xandreed/plugin-render"
import type { FeedOptions } from "@xandreed/plugin-render"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"

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
```

The turn route streams the turn, with the frames above, from `started` (its
number, and `after`, the journal cursor to follow it from if the stream
drops) to `done` (how it ended, its code, its usage). A turn that cannot
begin is answered before anything streams. `agent.turn` fails with the
refusal itself (a `TurnBeginError`: `SessionBusy`, `TurnDuplicate`…, its
fields kept), so the route matches the ones it answers apart with
`Effect.catchTags` (a busy session names its open turn) and gives the rest
a status for each code in `turnBeginCodes` (`harnessCodeOf`, through
`turnEndingOf`). The client sends an `Idempotency-Key`: a retry of a turn
that already ran begins nothing (`TurnDuplicate`) and gets that turn's
stored answer, or 409 while that turn still runs; the same key with another
message is `turn.key-conflict`. Without a key, a retry is a new turn, except
a resume's: the route keys a resume `resume:<n>`, as `Agent.turn` does, so
its retry is answered the same way.

<!-- snippet: packages/sdk/src/events-guide.test.ts#turn-route -->
```ts
import { Context, Deferred, Effect, Exit, Option, Schema } from "effect"
import { LanguageModel } from "effect/ai"
import { ConversationId, RunId, turnBeginCodes, turnEndingOf, UserMessage } from "@xandreed/sdk"
import type { SessionAddress, TurnBeginError, TurnError } from "@xandreed/sdk"
import { sseHeaders } from "@xandreed/plugin-render"

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
```

A session is created before its first turn (a turn for a session that does
not exist is 404). A client that names the id can retry the create safely:

<!-- snippet: packages/sdk/src/events-guide.test.ts#create-route -->
```ts
import { Effect, Schema } from "effect"
import { ConversationId, turnBeginCodes } from "@xandreed/sdk"

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
```

The journal route serves the session to anyone allowed to read it, from a
cursor: a reconnecting tab, another device, the same user tomorrow. What a
client is shown of each kind is the host's projection; prompts
(`request.prepared`, `memory.system`, `memory.section`, `memory.step`), tool
input and tool output are not forwarded here:

<!-- snippet: packages/sdk/src/events-guide.test.ts#project -->
```ts
import { Effect, Option, Schema } from "effect"
import { AssistantMessage, TurnEndedData } from "@xandreed/sdk"
import type { FeedPayload, FeedProjection } from "@xandreed/plugin-render"

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
```

The feed sends `retry: 1000` first, then one frame per shown record (`id:
<seq>`, `event: <kind>`, `data: <json>`), one `ready` frame once the
backlog is sent, and a `: heartbeat` comment while it is idle; records it
skips still move the cursor. It ends after `maxDurationMs` (240 s by
default, keep it below the platform's limit) and `EventSource` reconnects
with `Last-Event-ID`. The feed checks that limit between writes, so a write
is bounded as the turn's push is: a client that stays connected but stops
reading is dropped once a write has waited `timeout` (the stream is
aborted), and does not hold the route until the platform stops it.
Authorize before writing the response: a feed refused later still answers
200, and `EventSource` would retry it every second.

<!-- snippet: packages/sdk/src/events-guide.test.ts#events-route -->
```ts
import { Duration, Effect, Option, Schema } from "effect"
import { ConversationId, turnBeginCodes } from "@xandreed/sdk"
import { PrincipalId, sseHeaders, SseTransport, ThreadId } from "@xandreed/plugin-render"
import type { SsePeer } from "@xandreed/plugin-render"

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
    const frames = host.feed.frames({ threadId: ThreadId.make(session.value), principalId: PrincipalId.make(owner) }, cursorOf(request), clientProjection)
    waitUntil(Effect.runPromise(SseTransport.serve(frames, webSsePeer(writer, request.signal)).pipe(Effect.ensuring(closeStream(writer)))))
    return new Response(readable, { headers: sseHeaders })
  }).pipe(Effect.catchTags({
    SessionMissing: () => Effect.succeed(problem(404, turnBeginCodes.SessionMissing)),
    SessionLogError: () => Effect.succeed(problem(503, turnBeginCodes.SessionLogError)),
  })))
```

And a `/ping` for a load balancer, or a deploy waiting to stop the instance:

<!-- snippet: packages/sdk/src/events-guide.test.ts#ping -->
```ts
import { Effect } from "effect"

/** GET /ping: what this instance has in flight, for a deploy waiting to stop it; 503 once it is stopping, so a load balancer sends it no more turns. */
export const pingRoute = (host: Host): Promise<Response> => Effect.runPromise(host.agent.activity.pipe(Effect.map((now) =>
  Response.json({ busy: now.busy, stopping: now.stopping, openTurns: now.openTurns.length, beginningTurns: now.beginningTurns, runningTasks: now.runningTasks }, { status: now.stopping ? 503 : 200 }))))
```

In a Next.js App Router project, the routes are a few lines each.
`after` (from `next/server`, or `waitUntil` from `@vercel/functions`) keeps
the function running until the turn has ended, whether or not the client
is still reading:

<!-- unchecked: Next.js glue; the handlers it calls are the snippets above, and your own session store and sign-in -->
```ts
// lib/host.ts: one host per server instance
export const host = startHost({ log: SessionLogPostgresLive, model }) // your SessionLog, your model

// app/api/sessions/[id]/turns/route.ts
import { after } from "next/server"
export const runtime = "nodejs"
export const maxDuration = 300
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return turnRoute(await host, await ownerOf(request), (await params).id, request, after)
}

// app/api/sessions/[id]/events/route.ts: GET, the same with eventsRoute
```

On the client, read the turn's stream with `fetch` and a stream reader
(`EventSource` cannot send a POST or a body). When it drops, follow the
journal route from the `after` of its `started` frame, and match records to
frames by `turn` and `step`: the turn keeps running, and the text of each
step arrives with its `memory.message` record once the step has ended.

## Known limitations

- A `tool-params` delta does not carry the tool's name, and no event maps
  the provider's call id to the `invocationId` of the call's `tool.*` events.
- Bus events carry no `seq`: handing a client from the live stream to the
  journal takes a cursor the host reads, as the `started` frame's `after`
  does. Deltas are never journaled, so a step's text reaches the journal
  only once the step has ended.
- `Sessions.changes` is per instance: a feed on another instance polls. To
  wake it at once, implement plugin-render's `JournalTail` over
  `Sessions.read`, with a `changes` stream fed by your database's
  notifications.
- No event marks a provider retry or a compaction as it happens; a
  compaction is recorded as `memory.compaction`, and counted in
  `context.built.compactions`.
- No shared `SessionLog` for Node ships: a deployment with several
  instances implements the port over its own database.
