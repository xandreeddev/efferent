---
title: Render journal feed
description: Replay and follow an authorized journal as resumable frames for SSE or WebSocket transports.
pluginId: "@xandreed/plugin-render/feed"
---

`renderFeedPlugin` provides `RenderFeed`, a stream of client frames over a
host-provided journal tail. Use it for resumable event delivery after a
cursor, including clients catching up before following live updates.

It reads committed records. Following a feed does not run an agent turn or
publish speculative component proposals.

## Install and configure

```sh
bun add @xandreed/plugin-render
```

```ts
import type { Context } from "effect"
import { Agent } from "@xandreed/sdk"
import { JournalTail, renderFeedPlugin } from "@xandreed/plugin-render"

declare const hostServices: Context.Context<JournalTail>

const plugins = [
  {
    plugin: renderFeedPlugin,
    options: {
      pollMs: 200,
      maxPollMs: 1_000,
      heartbeatMs: 15_000,
      maxDurationMs: 240_000,
    },
  },
]

const definition = Agent.define({ plugins, services: hostServices })
```

Supply an actual `JournalTail` adapter and merge this fragment into the
agent graph described in [Getting started](/docs/getting-started/). Build
the definition in an Effect scope. An HTTP/WebSocket server and its peer
adapters remain host responsibilities.

## Authorization and projection

The runtime-scoped plugin requires only `JournalTail`; it does not require
the surface plugin. Authorize the feed's principal before opening it and
make the tail enforce access to the requested thread.

`SessionsJournalTailLive()` adapts `Sessions`: `threadId` names a session
and `principalId` its owner. It reads that session's events without writing
them. Its change stream wakes on commits from that instance; polling covers
commits made elsewhere.

Pass a `FeedProjection` to choose which records clients receive. Returning
`Option.none()` omits a payload while advancing the journal cursor. Keep
prompts, tool inputs and private result data server-side unless the host
explicitly intends to expose them.

A projection may read the host's own services: a `FeedProjection<R>`
requires `R`, and `frames` returns a stream that requires it too, so the
connection provides those services where it runs the stream, with no
context captured beforehand. Its failures are `RenderError`s, so map a
store's own error into one; a failure ends the connection. `payloadOf(schema)`
encodes a value with the host's schema into a `FeedPayload` (undefined fields
dropped, as on the wire), without casting the encoded object to JSON, and
fails with `invalid` when the value has no JSON form:

```ts
import { Context, Effect, Option, Schema } from "effect"
import { payloadOf, RenderError, RenderFeed } from "@xandreed/plugin-render"
import type { FeedProjection, FeedScope } from "@xandreed/plugin-render"

class Replies extends Context.Service<Replies, {
  readonly text: (sequence: number) => Effect.Effect<Option.Option<string>, Error>
}>()("example/Replies") {}

const Reply = Schema.Struct({ text: Schema.String, words: Schema.NumberFromString })
const reply = payloadOf(Reply)

const project: FeedProjection<Replies> = (record) => Effect.gen(function* () {
  if (record.kind !== "turn.reply") return Option.none()
  const text = yield* (yield* Replies).text(record.sequence).pipe(
    Effect.mapError((cause) => new RenderError({ code: "storage", message: cause.message })),
  )
  return yield* Effect.transposeOption(Option.map(text, (body) => reply("reply", { text: body, words: body.split(" ").length })))
})

// A stream of frames that requires Replies: the connection provides it.
const follow = (scope: FeedScope, after: number) =>
  RenderFeed.pipe(Effect.map((feed) => feed.frames(scope, after, project)))
```

## Connection lifecycle

The feed emits records after the cursor, one ready frame after the first
empty poll, then heartbeats while idle. Polling backs off up to `maxPollMs`;
an optional journal change signal wakes it sooner. If that signal fails or
ends, polling continues.

## Reading only some kinds

A projection usually shows a few journal kinds and skips the rest. Name
them as `kinds` in the options, the fourth argument of `frames`: the tail
reads only those (`JournalTail.read(feed, after, kinds)`, which
`SessionsJournalTailLive` passes to `Sessions.read`, so the store never
loads the records the client would not see), and records of other kinds
never reach the projection. The cursor still moves past every record the
tail returns, so a tail that cannot filter stays correct, only slower.
Absent or empty, `kinds` is every kind.

## Starting from a snapshot

Without a snapshot, a client at cursor 0 receives every record of the
journal, however long. With `snapshot: { head, fold }`, a client at cursor
0, or past `head` (its cursor is from a journal that was replaced), gets one
record with sequence `head` carrying the fold of the records up to `head`,
then the records after `head`. A client resuming at a cursor up to the head
is not sent the snapshot, and a client that reconnects with the snapshot's
sequence resumes after it. `head` must be a sequence the journal has
reached: a session's `seq` read when the client connects. The fold sees the
records of `kinds` only, may require services like the projection, and
fails with `RenderError`.

```ts
import { Effect, Option } from "effect"
import { Sessions } from "@xandreed/sdk"
import type { SessionAddress } from "@xandreed/sdk"
import { RenderFeed } from "@xandreed/plugin-render"
import type { FeedPayload, FeedProjection, FeedScope, SnapshotFold } from "@xandreed/plugin-render"

declare const scope: FeedScope
declare const address: SessionAddress
declare const project: FeedProjection

const kinds = ["turn.started", "turn.reply"]

// The client's state, as it applies each record's payload: the snapshot replaces it.
const apply = (lines: ReadonlyArray<string>, payload: FeedPayload): ReadonlyArray<string> =>
  payload.event === "transcript"
    ? (Array.isArray(payload.data.lines) ? payload.data.lines.filter((line) => typeof line === "string") : [])
    : [...lines, JSON.stringify(payload.data)]

// The records up to the head, projected and applied as a client would.
const fold: SnapshotFold = (records) =>
  Effect.forEach(records, project, { concurrency: 1 }).pipe(Effect.map((payloads) => ({
    event: "transcript",
    data: { lines: [...payloads.flatMap(Option.toArray).reduce(apply, [])] },
  })))

const follow = (after: number) => Effect.gen(function* () {
  const head = (yield* (yield* Sessions).get(address)).seq
  return (yield* RenderFeed).frames(scope, after, project, { kinds, snapshot: { head, fold } })
})
```

Prove a fold against its projection with `foldEqualsReplay` in a test:
over a sample journal, at 0 and at every sequence of it, a client that
starts from the snapshot (fresh, or holding a later state) holds the state
of one that applied every projected record up to that head, and both end
in the same state. It fails with `ConformanceFailure` naming the first head
that differs:

```ts
import { Effect } from "effect"
import { foldEqualsReplay } from "@xandreed/plugin-render"
import type { FeedPayload, FeedProjection, JournalRecord, SnapshotFold } from "@xandreed/plugin-render"

declare const sample: ReadonlyArray<JournalRecord>
declare const project: FeedProjection
declare const fold: SnapshotFold
declare const apply: (lines: ReadonlyArray<string>, payload: FeedPayload) => ReadonlyArray<string>

const proof = foldEqualsReplay({ records: sample, kinds: ["turn.started", "turn.reply"], project, fold, initial: [], apply })
await Effect.runPromise(proof)
```

## Live frames

A host that also streams what the journal never stores, such as a reply as
it is written, a preview or a build handshake, passes that stream as `live`
in the options of `frames`. Each payload goes out as a transient frame,
after the ready frame so the backlog comes first. The feed starts the live
stream before it folds a snapshot or reads the backlog, and holds what it
yields until the ready frame: a payload published while a cold client's
snapshot is folded, or while its backlog is read, reaches it after `ready`,
in the order it was published. At most `liveBuffer` payloads wait (256 by
default; an integer from 1 to 65 536, else the feed fails with `invalid`):
at the bound the feed pulls no more from `live` until the client takes some,
before the ready frame and after it. A pull-based or finite source (a
`Stream.fromIterable` of previews) therefore loses nothing and waits, while
a source that publishes on its own drops at its own capacity: a session's
channel keeps a follower's newest. The journal side never waits on the
live one. Transient frames carry no
sequence: over SSE they have no `id` line, so `Last-Event-ID` stays at the
last journaled record, and a reconnecting client receives only what the
journal kept. The feed still ends when its journal side does. A live stream
that ends stops only the live frames; one that fails, or a payload named
`ready`, ends the connection like a failing feed.

```ts
import { Effect, Stream } from "effect"
import { RenderFeed } from "@xandreed/plugin-render"
import type { FeedPayload, FeedProjection, FeedScope, RenderError } from "@xandreed/plugin-render"

declare const scope: FeedScope
declare const project: FeedProjection
declare const replyDeltas: Stream.Stream<string, RenderError>

const live: Stream.Stream<FeedPayload, RenderError> = replyDeltas.pipe(
  Stream.map((text): FeedPayload => ({ event: "reply.delta", data: { text } })),
)

const frames = RenderFeed.pipe(Effect.map((feed) => feed.frames(scope, 0, project, { live })))
```

When the live frames are a session's, and the turn that makes them may run
in another request, take them from the session's channel: `sessionLive`
follows core's `SessionChannel` for the feed's session (`threadId` the
session, `principalId` its owner, as `SessionsJournalTailLive` reads them),
so every feed open on the session shows what a turn shares with
`shareTransient` and what the host publishes there itself. A feed sees
what is published from the time it starts, its snapshot's fold included,
so a client that connects mid-turn gets the snapshot, the records after
its head, `ready`, then the rest of that turn's transient events; nothing
published before the feed started is replayed.

```ts
import { Effect } from "effect"
import { RenderFeed, sessionLive } from "@xandreed/plugin-render"
import type { FeedProjection, FeedScope } from "@xandreed/plugin-render"

declare const scope: FeedScope
declare const project: FeedProjection
declare const after: number

const frames = Effect.all([RenderFeed, sessionLive(scope)], { concurrency: 1 }).pipe(
  Effect.map(([feed, live]) => feed.frames(scope, after, project, { live })),
)
```

A name that is not a session fails the feed with `invalid`; a channel whose
transport cannot be reached, with `unavailable`. Provide the channel with
`SessionChannelMemoryLive` from [sessions](/docs/plugins/sessions/#live-events-for-every-follower)
in one process, or an adapter over the host's broker across instances.

The stream ends after `maxDurationMs`; clients reconnect with their last
cursor. `SseTransport` and `WebSocketTransport` carry equivalent frame
content. Serve them at the host edge and close their scoped work when the
peer disconnects. Feed failures are logged and end the connection rather
than exposing an internal error to the client.

When the frames end, by `maxDurationMs` or a failed feed, `SseTransport`
ends its peer once (`SsePeer.end`), so the response completes and the client
reconnects; a client that already left is never ended.

The package supports Node 24 and Bun. `sseNodePeer` is the Node response
adapter; another host can implement the small peer interface (`write`,
`closed`, `end`) itself. Pass the request's `Accept-Encoding` as `compress`
to send the feed in Brotli, else gzip, else uncompressed, as the client
accepts (`sseContentEncodingOf` decides). One compression window covers the
connection and every write is flushed, so frames are not held back:

```ts
import type { IncomingMessage, ServerResponse } from "node:http"
import { Effect, Stream } from "effect"
import { SseTransport, sseNodePeer } from "@xandreed/plugin-render"
import type { FeedFrame, RenderError } from "@xandreed/plugin-render"

declare const frames: Stream.Stream<FeedFrame, RenderError>

const serve = (request: IncomingMessage, response: ServerResponse) =>
  sseNodePeer(response, {}, "2 seconds", { compress: request.headers["accept-encoding"] }).pipe(
    Effect.flatMap((peer) => SseTransport.serve(frames, peer)),
  )
```

`renderFeedConformance` and `renderTransportConformance` exercise adapters;
`foldEqualsReplay` checks a host's snapshot fold.

## Related guides

- [Events and HTTP serving](/docs/guides/events/#serving-turns-over-http).
- [Render surfaces](/docs/plugins/render-surface/) for versioned publication.
- [Component output](/docs/plugins/render-output/) for durable component receipts.
- [Context and journal](/docs/concepts/context-journal/) for stored events versus model context.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-render/feed` · Version **0.19.0** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/render/Feed` |
| Requires | `efferent/render/JournalTail` |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "pollMs": 200,
  "maxPollMs": 1000,
  "heartbeatMs": 15000,
  "maxDurationMs": 240000
}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "pollMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxPollMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "heartbeatMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxDurationMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    }
  },
  "required": [
    "pollMs",
    "maxPollMs",
    "heartbeatMs",
    "maxDurationMs"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
