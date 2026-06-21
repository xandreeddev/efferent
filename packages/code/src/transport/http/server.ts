import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  ApprovalDecision,
  AuthStore,
  CreateFleetRequest,
  Directive,
  FleetMessage,
  ImportResult,
  Settings,
  SettingsPatch,
  SessionState,
  SessionSummary,
  SpawnRequest,
  Workspace,
  WorkspaceMetrics,
  WorkspaceSnapshot,
  type SessionId,
} from "@xandreed/sdk-core"
import { encodeHeartbeat, encodeSeqEvent } from "./sse.js"

/**
 * HTTP server — the **swappable transport adapter** (server half). It maps the
 * `Workspace` port 1:1 onto HTTP + SSE and is the ONLY place `@effect/platform`
 * HTTP appears. The daemon = `AppLive` + the in-process Workspace + this. A
 * different wire (unix socket, websocket) is a sibling `transport/<name>/`
 * pair against the same port — agent/UI code never changes.
 *
 * Lower-level `HttpRouter` + `HttpServerResponse.stream` (not `HttpApi`, which
 * can't model an open SSE byte stream). Bodies decode through the protocol
 * Schemas; responses encode through them.
 */

/** Server identity for the discovery file + health poll. */
export interface DaemonIdentity {
  readonly pid: number
  readonly workspace: string
  readonly version: string
}

const SendBody = Schema.Struct({ prompt: Schema.String })
const ModelBody = Schema.Struct({ model: Schema.String })
const ImportBody = Schema.Struct({ spec: Schema.String })
const DirectiveBody = Schema.Struct({ directive: Schema.NullOr(Directive) })
const SinceParams = Schema.Struct({ since: Schema.optional(Schema.NumberFromString) })
const HealthResponse = Schema.Struct({
  pid: Schema.Number,
  workspace: Schema.String,
  version: Schema.String,
})

const json = HttpServerResponse.schemaJson(Schema.Any)
const noContent = HttpServerResponse.empty({ status: 204 })

/** The `:id` path param as a `SessionId` (a branded UUID string; the Workspace
 *  treats it as an opaque key, so a cast is sound). */
const sessionParam = Effect.gen(function* () {
  const params = yield* HttpRouter.params
  return (params.id ?? "") as SessionId
})

/**
 * The Workspace HTTP router. Requires `Workspace` (provided by the daemon's
 * in-process adapter). The endpoints mirror the port; `GET /sessions/:id/events`
 * is the SSE stream. `opts.onShutdown` (when given) runs on `POST /shutdown` —
 * the daemon passes a trigger that tears itself down.
 */
export const workspaceRouter = (
  identity: DaemonIdentity,
  opts: { readonly onShutdown?: Effect.Effect<void> } = {},
) =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      "/health",
      HttpServerResponse.schemaJson(HealthResponse)(identity),
    ),
    HttpRouter.get(
      "/snapshot",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const snap = yield* ws.snapshot()
        return yield* HttpServerResponse.schemaJson(WorkspaceSnapshot)(snap)
      }),
    ),
    HttpRouter.get(
      "/sessions",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const sessions = yield* ws.listSessions()
        return yield* HttpServerResponse.schemaJson(Schema.Array(SessionSummary))(sessions)
      }),
    ),
    HttpRouter.get(
      "/metrics",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const m = yield* ws.metrics()
        return yield* HttpServerResponse.schemaJson(WorkspaceMetrics)(m)
      }),
    ),
    HttpRouter.get(
      "/messages",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const { limit } = yield* HttpServerRequest.schemaSearchParams(
          Schema.Struct({ limit: Schema.optional(Schema.NumberFromString) }),
        )
        const msgs = yield* ws.messages(limit)
        return yield* HttpServerResponse.schemaJson(Schema.Array(FleetMessage))(msgs)
      }),
    ),
    HttpRouter.post(
      "/sessions",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const req = yield* HttpServerRequest.schemaBodyJson(SpawnRequest)
        const id = yield* ws.spawn(req)
        return yield* json(id)
      }),
    ),
    HttpRouter.post(
      "/fleets",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const req = yield* HttpServerRequest.schemaBodyJson(CreateFleetRequest)
        const id = yield* ws.createFleet(req)
        return yield* json(id)
      }),
    ),
    HttpRouter.post(
      "/sessions/:id/model",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const id = yield* sessionParam
        const { model } = yield* HttpServerRequest.schemaBodyJson(ModelBody)
        yield* ws.setFleetModel(id, model)
        return noContent
      }),
    ),
    HttpRouter.get(
      "/sessions/:id/state",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const id = yield* sessionParam
        const { since } = yield* HttpServerRequest.schemaSearchParams(SinceParams)
        const state = yield* ws.getState(id, since)
        return yield* HttpServerResponse.schemaJson(SessionState)(state)
      }),
    ),
    HttpRouter.post(
      "/sessions/:id/send",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const id = yield* sessionParam
        const { prompt } = yield* HttpServerRequest.schemaBodyJson(SendBody)
        yield* ws.send(id, prompt)
        return noContent
      }),
    ),
    HttpRouter.post(
      "/sessions/:id/interrupt",
      Effect.gen(function* () {
        const ws = yield* Workspace
        yield* ws.interrupt(yield* sessionParam)
        return noContent
      }),
    ),
    HttpRouter.post(
      "/sessions/:id/stop",
      Effect.gen(function* () {
        const ws = yield* Workspace
        yield* ws.stop(yield* sessionParam)
        return noContent
      }),
    ),
    HttpRouter.post(
      "/sessions/:id/approve",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const id = yield* sessionParam
        const decision = yield* HttpServerRequest.schemaBodyJson(ApprovalDecision)
        yield* ws.approve(id, decision)
        return noContent
      }),
    ),
    HttpRouter.get(
      "/sessions/:id/events",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const id = yield* sessionParam
        const { since } = yield* HttpServerRequest.schemaSearchParams(SinceParams)
        // Replay-then-tail event frames, merged with a keep-alive heartbeat.
        const events = ws.subscribe(id, since).pipe(
          Stream.map(encodeSeqEvent),
          Stream.catchAll(() => Stream.empty),
        )
        const heartbeat = Stream.repeatEffect(
          Effect.as(Effect.sleep("15 seconds"), encodeHeartbeat()),
        )
        const encoder = new TextEncoder()
        const bytes = Stream.merge(events, heartbeat).pipe(
          Stream.map((s) => encoder.encode(s)),
        )
        return HttpServerResponse.stream(bytes, {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-cache", connection: "keep-alive" },
        })
      }),
    ),
    // (split: `HttpRouter.pipe` accepts at most ~20 steps, so the route table
    // is chained as two pipes.)
  ).pipe(
    HttpRouter.get(
      "/settings",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const s = yield* ws.getSettings()
        return yield* HttpServerResponse.schemaJson(Settings)(s)
      }),
    ),
    HttpRouter.post(
      "/settings",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const patch = yield* HttpServerRequest.schemaBodyJson(SettingsPatch)
        const s = yield* ws.updateSettings(patch)
        return yield* HttpServerResponse.schemaJson(Settings)(s)
      }),
    ),
    HttpRouter.get(
      "/directive",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const directive = yield* ws.getDirective()
        return yield* HttpServerResponse.schemaJson(DirectiveBody)({
          directive: directive ?? null,
        })
      }),
    ),
    HttpRouter.post(
      "/directive",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const { directive } = yield* HttpServerRequest.schemaBodyJson(DirectiveBody)
        yield* ws.setDirective(directive ?? undefined)
        return noContent
      }),
    ),
    HttpRouter.post(
      "/agents/import",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const { spec } = yield* HttpServerRequest.schemaBodyJson(ImportBody)
        const res = yield* ws.importAgents(spec)
        return yield* HttpServerResponse.schemaJson(ImportResult)(res)
      }),
    ),
    HttpRouter.post(
      "/tools/import",
      Effect.gen(function* () {
        const ws = yield* Workspace
        const { spec } = yield* HttpServerRequest.schemaBodyJson(ImportBody)
        const res = yield* ws.importTools(spec)
        return yield* HttpServerResponse.schemaJson(ImportResult)(res)
      }),
    ),
    // OAuth/API-key login happens CLIENT-side (browser + auth.json are the
    // human's machine); this tells the daemon to reload the AuthStore so a
    // mid-session login is picked up without a restart.
    HttpRouter.post(
      "/auth/reload",
      Effect.gen(function* () {
        yield* (yield* AuthStore).init(identity.workspace)
        return noContent
      }),
    ),
    // Graceful stop: answer 204 first, then trigger teardown (the daemon removes
    // its discovery file + exits). A no-op when no trigger is wired.
    HttpRouter.post(
      "/shutdown",
      Effect.gen(function* () {
        if (opts.onShutdown !== undefined) yield* opts.onShutdown
        return noContent
      }),
    ),
  )

/**
 * Serve the Workspace over HTTP on `127.0.0.1:<port>` (loopback only). The
 * resulting layer requires `Workspace` (the daemon provides the in-process
 * adapter). Transport is referenced ONLY here — swapping it changes this line.
 */
export const serveWorkspaceHttp = (opts: {
  readonly identity: DaemonIdentity
  readonly port: number
}): Layer.Layer<never, never, Workspace | AuthStore> =>
  HttpServer.serve()(workspaceRouter(opts.identity)).pipe(
    Layer.provide(BunHttpServer.layer({ port: opts.port, hostname: "127.0.0.1" })),
  ) as Layer.Layer<never, never, Workspace | AuthStore>
