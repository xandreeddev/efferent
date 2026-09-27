import { Schema } from "effect"
import { definePlugin } from "@xandreed/core"
import { FeedOptions } from "./domain/feed-frame.entity.js"
import { UiOutputAdmission } from "./ports/render-output.port.js"
import { JournalTail, Render, RenderFeed, RenderStore } from "./ports/render.port.js"
import { RenderFeedLive } from "./render-feed.adapter.js"
import { RenderLive } from "./render-surface.adapter.js"

const SurfaceConfig = Schema.Struct({ maxBytes: Schema.Int.pipe(Schema.between(1024, 131_072)) })
const surfaceDefaults: typeof SurfaceConfig.Type = { maxBytes: 32_768 }

/** Surfaces over the host's RenderStore, with the host's admission rules. */
export const renderSurfacePlugin = definePlugin({
  id: "@xandreed/plugin-render/surface", version: "0.6.0-next.0", scope: "runtime",
  requires: [RenderStore, UiOutputAdmission],
  provides: [Render],
  config: SurfaceConfig, defaults: surfaceDefaults,
  layer: ({ maxBytes }) => RenderLive(maxBytes),
})

const feedDefaults: typeof FeedOptions.Type = { pollMs: 200, maxPollMs: 1_000, heartbeatMs: 15_000, maxDurationMs: 240_000 }

/** The journal as client frames; pair it with SseTransport or WebSocketTransport at the host's HTTP edge. */
export const renderFeedPlugin = definePlugin({
  id: "@xandreed/plugin-render/feed", version: "0.6.0-next.0", scope: "runtime",
  requires: [JournalTail],
  provides: [RenderFeed],
  config: FeedOptions, defaults: feedDefaults,
  layer: (options) => RenderFeedLive(options),
})
