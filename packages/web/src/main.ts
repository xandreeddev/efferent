#!/usr/bin/env bun
import { HttpRouter, HttpServer } from "@effect/platform"
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"

import {
  DatabaseLive,
  GeminiFastLive,
  GeminiLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  PostgresCaptureStoreLive,
  PostgresConversationStoreLive,
} from "@agent/adapters"

import { chatStreamRoute } from "./routes/chat.js"
import { indexRoute } from "./routes/index.js"

const PORT = Number(process.env["PORT"] ?? 3000)

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/", indexRoute),
  HttpRouter.get("/ui/stream", chatStreamRoute),
)

const AppLive = Layer.mergeAll(
  PostgresCaptureStoreLive.pipe(Layer.provide(DatabaseLive)),
  PostgresConversationStoreLive.pipe(Layer.provide(DatabaseLive)),
  GeminiLive,
  GeminiFastLive,
  LocalFileSystemLive,
).pipe(
  Layer.provideMerge(
    LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
  ),
)

// idleTimeout 0 disables Bun's per-request timeout — agent calls + render
// can run ~5–15s and the default 10s would drop the SSE connection.
const HttpLive = HttpServer.serve(router).pipe(
  Layer.provide(
    BunHttpServer.layer({ port: PORT, idleTimeout: 0 }),
  ),
  Layer.provide(AppLive),
  Layer.provide(BunContext.layer),
)

BunRuntime.runMain(Layer.launch(HttpLive))
