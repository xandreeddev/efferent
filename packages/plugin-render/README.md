# @xandreed/plugin-render

Render agent output onto durable surfaces and stream the journal to clients over SSE or WebSocket.
The host supplies storage (`RenderStore`), admission rules (`UiOutputAdmission`) and a journal tail
(`JournalTail`); the plugin owns versions, deduplication, freezing, background preparation and the wire.

```ts
import { Effect, Option, Stream } from "effect"
import { Render, RenderFeed, SseTransport, sseNodePeer, renderSurfacePlugin, renderFeedPlugin, SurfaceId } from "@xandreed/plugin-render"

// A run: open the surface for this message and publish JSON snapshots. The host mints the scope's
// branded ids (`ThreadId.make(…)`, core's `RunId.make(…)`, …) and raises `fence` for each newer writer.
const renderPage = (tasks: { fork: (tag: string, work: Effect.Effect<void>) => Effect.Effect<void> }) => Effect.gen(function* () {
  const surface = yield* (yield* Render).open({
    threadId, runId, messageId, principalId, fence, surfaceId: SurfaceId.make("page"), baseVersion: Option.none(),
  }, { fork: tasks.fork })
  yield* surface.prepare(composer.snapshots(), (error) => Effect.logWarning(error))   // background, one at a time
  yield* surface.settled
  yield* surface.freeze("completion")
})

// The HTTP edge: project journal records to client events and serve them over SSE, compressed as the
// request accepts; the response ends when the feed does.
const serveEvents = (request, response, feedScope, after: number) => Effect.gen(function* () {
  const feed = yield* RenderFeed
  const peer = yield* sseNodePeer(response, {}, "2 seconds", { compress: request.headers["accept-encoding"] })
  yield* SseTransport.serve(feed.frames(feedScope, after, project), peer)
})
```

- `RenderSurface.publish(snapshot)` versions content as `<messageId>:v<generation>`, commits each node
  once (`<runId>:render:<surfaceId>:<generation>:<nodeId>`; a `:` or `%` inside a part is
  percent-encoded), records completion, and on a surface frozen elsewhere records a frozen, partial
  completion instead of failing. Publishing identical content again opens no generation but commits
  the nodes an earlier, failed attempt left uncommitted (`changed: true`), then completes. When
  another writer planned first, the publish re-reads the surface once and resumes that version (same
  content) or plans the next one; a second conflict fails it.
- `fill(placeholder, node)` commits into a declared placeholder of the current version
  (`<runId>:render:<surfaceId>:<generation>:fill:<placeholder>`), also after freezing.
- `freeze(reason)` holds at the version reached, or before the first publish (a `SurfaceFrozen`
  whose `versionId` is `None`); each surface of a message freezes on its own.
- A `RenderStore` keeps a surface's records under the scope's thread and principal: `hydrate` returns
  that surface's records and nothing from another thread or principal, and `commit` is idempotent
  by operation id within them. Each write checks, in its own transaction, the scope's `fence`
  against the highest the surface and message accepted (lower is `forbidden`), and `plan` takes only
  the next generation (anything else is a `conflict`), so two writers of one message never plan the
  same version. `MemoryRenderStoreLive` does this in process.
- `RenderFeed.frames` sends records after the cursor, one `ready` frame once caught up, and heartbeats
  while idle; the stream ends after `maxDurationMs` and clients reconnect with their cursor. Idle
  polling backs off. A `JournalTail` may also offer `changes(feed)`, a stream whose every element
  wakes the feed to poll at once (a database notification, an in-process signal). Polling stays the
  fallback: a failed or ended `changes` stream only stops the wake-ups. A host that also streams what
  the journal never stores (a reply as it is written, a preview, a build handshake) passes it as
  `live` in the options, the fourth argument: each payload goes out as a `FeedTransient` frame after
  the ready frame, the feed still ends when the journal side does, and a transient frame never moves
  the resume cursor (a reconnecting client gets only what the journal kept). The feed starts `live`
  before it folds the snapshot or reads the backlog and holds its payloads until the ready frame, so
  what is published while a cold client catches up reaches it after `ready`, in order; `liveBuffer`
  (256 by default, 1 to 65 536) bounds what waits: at the bound the feed pulls no more until the
  client takes some, so a pull-based or finite source loses nothing, while a source that publishes on
  its own (a session's channel) drops at its own capacity. A live stream that ends stops
  only the live frames; one that fails, or a payload named `ready`, fails the feed.
- `kinds` in the options names the journal kinds the projection uses: the tail reads only those
  (`JournalTail.read(feed, after, kinds)`; `SessionsJournalTailLive` passes them to `Sessions.read`,
  so prompts, tool input and images are never loaded for a client that shows none), and records of
  other kinds never reach the projection, while the cursor moves past them.
- `snapshot: { head, fold }` starts a cold client from the current state instead of a replay of every
  record: a client at cursor 0, or past `head`, gets one record with sequence `head` carrying
  `fold(records 1..head)` (of `kinds`), then the records after `head`; a client at a cursor in
  `1..head` resumes as before. `head` is a sequence the journal has reached (a session's `seq` when
  the client connects). `foldEqualsReplay({ records, kinds, project, fold, initial, apply })` checks,
  at every head of a sample journal, that a client starting from the snapshot holds the state of
  one that applied every projected record:

  ```ts
  const view = yield* sessions.get(address)
  const frames = feed.frames(feedScope, after, project, { kinds: ["turn.started", "turn.reply"], snapshot: { head: view.seq, fold } })
  ```
- A `FeedProjection<R>` (and a `SnapshotFold<R>`) may require the host's services: `frames` returns
  a stream that requires them too, provided where the connection runs it. It fails with `RenderError` (a projection maps a
  store's error into one). `payloadOf(schema)(event, value)` encodes a value with the host's schema
  into a `FeedPayload`, dropping `undefined` fields, and fails with `invalid` when it has no JSON form.
- SSE wire: `retry: 1000`, then `id: <sequence>` / `event: <event>` / `data: <json>` blocks,
  transient `event: <event>` / `data: <json>` blocks with no `id`, `event: ready`, and `: heartbeat` comments. `decodeSse(text)` reads them back as a `Result`: a
  malformed record or transient frame fails with `RenderError` code `invalid`. An `SsePeer` writes, says when the client
  left (`closed`) and ends the response (`end`): `SseTransport` ends it once when the frames end (the
  feed's `maxDurationMs`, or a failed feed), never after the client left. `sseNodePeer(response,
  headers, timeout, { compress })` drops a client that has not taken a write within `timeout` (2
  seconds), and ends the response itself. Given the request's `Accept-Encoding` as `compress`, it
  sends Brotli when the client takes it, else gzip, else no coding (`sseContentEncodingOf`), with
  `content-encoding` and `vary: accept-encoding`, over one compression window for the connection,
  flushed after every write so no frame waits for the next. A feed that fails ends the
  connection like a finished one, and the transport logs the failure as a warning. WebSocket wire: one JSON object per frame
  (`{"type":"record","sequence":n,"event":…,"data":{…}}`, `{"type":"transient","event":…,"data":{…}}`,
  `{"type":"ready"}`, `{"type":"heartbeat"}`);
  a client resumes by sending `{"after": n}`.
- Conformance kits (`renderSurfaceConformance`, `renderFeedConformance`, `renderTransportConformance`)
  hold any store, feed or transport implementation to the same contract; `foldEqualsReplay` holds a
  host's snapshot fold to its projection.
