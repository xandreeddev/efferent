#!/usr/bin/env bun
import { HttpRouter, HttpServer } from "@effect/platform"
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"

import {
  DatabaseLive,
  LlmLive,
  PostgresCaptureStoreLive,
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
  LlmLive,
)

const HttpLive = HttpServer.serve(router).pipe(
  Layer.provide(BunHttpServer.layer({ port: PORT })),
  Layer.provide(AppLive),
  Layer.provide(BunContext.layer),
)

BunRuntime.runMain(Layer.launch(HttpLive))
