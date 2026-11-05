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

## Live frames

A host that also streams what the journal never stores, such as a reply as
it is written, a preview or a build handshake, passes that stream as the
fourth argument of `frames`. Each payload goes out as a transient frame,
after the ready frame so the backlog comes first. Transient frames carry no
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

const frames = RenderFeed.pipe(Effect.map((feed) => feed.frames(scope, 0, project, live)))
```

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

`renderFeedConformance` and `renderTransportConformance` exercise adapters.

## Related guides

- [Events and HTTP serving](/docs/guides/events/#serving-turns-over-http).
- [Render surfaces](/docs/plugins/render-surface/) for versioned publication.
- [Component output](/docs/plugins/render-output/) for durable component receipts.
- [Context and journal](/docs/concepts/context-journal/) for stored events versus model context.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-render/feed` · Version **0.17.0** · Plugin API **3** · Scope **runtime**

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
