# @xandreed/plugin-render

Render agent output onto durable surfaces and stream the journal to clients over SSE or WebSocket.
The host supplies storage (`RenderStore`), admission rules (`UiOutputAdmission`) and a journal tail
(`JournalTail`); the plugin owns versions, deduplication, freezing, background preparation and the wire.

```ts
import { Effect, Option, Stream } from "effect"
import { Render, RenderFeed, SseTransport, sseNodePeer, renderSurfacePlugin, renderFeedPlugin } from "@xandreed/plugin-render"

// A run: open the surface for this message and publish JSON snapshots.
const renderPage = (tasks: { fork: (tag: string, work: Effect.Effect<void>) => Effect.Effect<void> }) => Effect.gen(function* () {
  const surface = yield* (yield* Render).open({
    threadId, runId, messageId, principalId, fence, surfaceId: "page", baseVersion: Option.none(),
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
  once (`<runId>:render:<generation>:<nodeId>`), records completion, and on a surface frozen elsewhere
  records a frozen, partial completion instead of failing.
- `fill(placeholder, node)` commits into a declared placeholder, also after freezing.
- `RenderFeed.frames` sends records after the cursor, one `ready` frame once caught up, and heartbeats
  while idle; the stream ends after `maxDurationMs` and clients reconnect with their cursor. Idle
  polling backs off. A `JournalTail` may also offer `changes(feed)`, a stream whose every element
  wakes the feed to poll at once (a database notification, an in-process signal). Polling stays the
  fallback: a failed or ended `changes` stream only stops the wake-ups.
- SSE wire: `retry: 1000`, then `id: <sequence>` / `event: <event>` / `data: <json>` blocks,
  `event: ready`, and `: heartbeat` comments. WebSocket wire: one JSON object per frame
  (`{"type":"record","sequence":n,"event":…,"data":{…}}`, `{"type":"ready"}`, `{"type":"heartbeat"}`);
  a client resumes by sending `{"after": n}`.
- Conformance kits (`renderSurfaceConformance`, `renderFeedConformance`, `renderTransportConformance`)
  hold any store, feed or transport implementation to the same contract.
