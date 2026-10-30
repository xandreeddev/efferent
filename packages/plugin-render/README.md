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

// The HTTP edge: project journal records to client events and serve them over SSE.
const serveEvents = (response, feedScope, after: number) => Effect.gen(function* () {
  const feed = yield* RenderFeed
  const peer = yield* sseNodePeer(response)
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
  fallback: a failed or ended `changes` stream only stops the wake-ups.
- SSE wire: `retry: 1000`, then `id: <sequence>` / `event: <event>` / `data: <json>` blocks,
  `event: ready`, and `: heartbeat` comments. `decodeSse(text)` reads them back as a `Result`: a
  malformed record fails with `RenderError` code `invalid`. `sseNodePeer(response, headers, timeout)`
  drops a client that has not taken a write within `timeout` (2 seconds). A feed that fails ends the
  connection like a finished one, and the transport logs the failure as a warning. WebSocket wire: one JSON object per frame
  (`{"type":"record","sequence":n,"event":…,"data":{…}}`, `{"type":"ready"}`, `{"type":"heartbeat"}`);
  a client resumes by sending `{"after": n}`.
- Conformance kits (`renderSurfaceConformance`, `renderFeedConformance`, `renderTransportConformance`)
  hold any store, feed or transport implementation to the same contract.
