/**
 * The web UI's HTTP + WebSocket server — a sibling of `transport/http/server.ts`
 * (same lower-level HttpRouter on BunHttpServer; HttpApi can't model the open
 * socket). Serves the shell + static assets from `@xandreed/web`, upgrades
 * `GET /ws` into the fragment stream, and maps browser POSTs onto the
 * Workspace port.
 *
 * Auth: the printed URL carries a per-boot token (`GET /?t=…`); serving the
 * page sets it as a cookie, and the WS upgrade + every POST validate the
 * cookie (agent-authored forms can't carry a token; cookies ride along).
 * Loopback bind remains the primary defense.
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, PubSub, Queue, Ref } from "effect"
import { ApprovalDecision, Workspace, type SessionId } from "@xandreed/sdk-core"
import {
  ACTION_APPROVE_PATH,
  ACTION_INTERRUPT_PATH,
  ACTION_UI_PATH,
  formatUiActionMessage,
  parseActionPayload,
  parseClientMessage,
  staticAssets,
  withViewingContext,
} from "@xandreed/web"
import type { FragmentPump } from "./pump.js"
import { renderPage, type WebMeta } from "./render.js"
import type { WebModel } from "./model.js"

export interface WebServerIdentity {
  readonly pid: number
  readonly workspace: string
  readonly version: string
}

const COOKIE = "efweb"

const noContent = HttpServerResponse.empty({ status: 204 })
const unauthorized = HttpServerResponse.text("unauthorized", { status: 401 })

const authed = (token: string) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    return req.cookies[COOKIE] === token
  })

/** Decode a form-encoded or JSON body into a flat string record. */
const bodyFields = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const text = yield* req.text
  const contentType = req.headers["content-type"] ?? ""
  if (contentType.includes("application/json")) {
    const parsed = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(
      Effect.orElseSucceed(() => ({}) as unknown),
    )
    const out: Record<string, string> = {}
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v
        else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v)
      }
    }
    return out
  }
  const params = new URLSearchParams(text)
  const out: Record<string, string> = {}
  for (const [k, v] of params.entries()) out[k] = v
  return out
})

export const webRouter = (deps: {
  readonly identity: WebServerIdentity
  readonly pump: FragmentPump
  readonly sessionId: SessionId
  readonly meta: WebMeta
  readonly currentModel: Effect.Effect<WebModel>
  readonly token: string
  readonly onShutdown?: Effect.Effect<void>
  /** Resolves when the server is shutting down — every open WS races against
   *  it, else the teardown drain waits forever on sockets parked in
   *  `Queue.take` (the shutdown-hang found in the live smoke). */
  readonly closed?: Effect.Effect<void>
}) => {
  const { pump, sessionId, meta, token } = deps

  const guard = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* authed(token))) return unauthorized
      return yield* handler
    })

  /** POST /send + WS "chat" share this: queue locally when busy (the daemon
   *  queues server-side too; the authoritative user_message drains the echo).
   *  `page` (the composer's hidden field — the tab the user is viewing) rides
   *  as a `[viewing:<id>]` prefix so the agent updates the RIGHT page. */
  const sendPrompt = (prompt: string, page?: string) =>
    Effect.gen(function* () {
      const full = withViewingContext(prompt, page)
      const ws = yield* Workspace
      if (yield* pump.busy) yield* pump.enqueueLocal(full)
      yield* ws.send(sessionId, full)
    })

  let assetRoutes = HttpRouter.empty
  for (const asset of staticAssets) {
    assetRoutes = assetRoutes.pipe(
      HttpRouter.get(
        asset.path as `/${string}`,
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest
          if (req.headers["if-none-match"] === asset.hash) {
            return HttpServerResponse.empty({ status: 304 })
          }
          return HttpServerResponse.text(asset.content, {
            headers: {
              "content-type": asset.contentType,
              etag: asset.hash,
              "cache-control": "public, max-age=31536000, immutable",
            },
          })
        }),
      ),
    )
  }

  return assetRoutes.pipe(
    HttpRouter.get(
      "/health",
      HttpServerResponse.json({
        pid: deps.identity.pid,
        workspace: deps.identity.workspace,
        version: deps.identity.version,
      }).pipe(Effect.orDie),
    ),

    // The page: `?t=<token>` bootstraps the cookie; with the cookie already
    // set, a bare `/` works too. Wrong/missing token+cookie → 401.
    HttpRouter.get(
      "/",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(req.url, "http://localhost")
        const t = url.searchParams.get("t")
        const hasCookie = req.cookies[COOKIE] === token
        if (t !== token && !hasCookie) return unauthorized
        const model = yield* deps.currentModel
        const page = renderPage(model, meta)
        return HttpServerResponse.html(page).pipe(
          HttpServerResponse.setHeader(
            "set-cookie",
            `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
          ),
        )
      }),
    ),

    // The WebSocket: server→client fragment batches; client→server chat/resync.
    HttpRouter.get(
      "/ws",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        if (req.cookies[COOKIE] !== token) return unauthorized
        const ws = yield* Workspace
        const socket = yield* req.upgrade
        yield* Effect.scoped(
          Effect.gen(function* () {
            const write = yield* socket.writer
            // Subscribe FIRST, then snapshot: a frame published in between
            // arrives twice, which the keyed OOB ids make harmless — a frame
            // can never be LOST.
            const sub = yield* PubSub.subscribe(pump.hub)
            yield* write(yield* pump.fullRender)
            const outbound = Effect.forever(
              Queue.take(sub).pipe(Effect.flatMap((batch) => write(batch))),
            )
            const decoder = new TextDecoder()
            const inbound = socket.run((data) => {
              const msg = parseClientMessage(typeof data === "string" ? data : decoder.decode(data))
              if (msg === undefined) return Effect.void
              switch (msg.type) {
                case "chat":
                  return sendPrompt(msg.prompt, msg.page).pipe(
                    Effect.provideService(Workspace, ws),
                    Effect.catchAll(() => Effect.void),
                  )
                case "resync":
                  return pump.fullRender.pipe(Effect.flatMap(write), Effect.catchAll(() => Effect.void))
                case "ping":
                  return Effect.void
              }
            })
            // The socket closing (inbound ends), the hub dying, or the server
            // shutting down — whichever first — tears the connection down.
            yield* Effect.race(Effect.race(outbound, inbound), deps.closed ?? Effect.never)
          }),
        ).pipe(Effect.catchAll(() => Effect.void)) // a dropped tab is not a server error
        return HttpServerResponse.empty()
      }),
    ),

    // Curl/script convenience — same path the WS chat takes.
    HttpRouter.post(
      "/send",
      guard(
        Effect.gen(function* () {
          const fields = yield* bodyFields
          const prompt = (fields["prompt"] ?? "").trim()
          if (prompt === "") return HttpServerResponse.text("missing prompt", { status: 400 })
          const page = (fields["page"] ?? "").trim()
          yield* sendPrompt(prompt, page === "" ? undefined : page)
          return noContent
        }),
      ),
    ),

    // Generative-UI form posts → a user message the agent reads.
    HttpRouter.post(
      ACTION_UI_PATH as "/action/ui",
      guard(
        Effect.gen(function* () {
          const fields = yield* bodyFields
          const payload = parseActionPayload(fields)
          if (Object.keys(payload.fields).length === 0) return noContent
          yield* sendPrompt(formatUiActionMessage(payload))
          return noContent
        }),
      ),
    ),

    // The approval sheet's decision buttons.
    HttpRouter.post(
      ACTION_APPROVE_PATH as "/action/approve",
      guard(
        Effect.gen(function* () {
          const ws = yield* Workspace
          const fields = yield* bodyFields
          const d = fields["decision"]
          const decision: ApprovalDecision =
            d === "once" || d === "session" || d === "project"
              ? { kind: "allow", scope: d }
              : {
                  kind: "deny",
                  ...((fields["reason"] ?? "").trim() !== ""
                    ? { reason: (fields["reason"] ?? "").trim() }
                    : {}),
                }
          yield* ws.approve(sessionId, decision)
          return noContent
        }),
      ),
    ),

    HttpRouter.post(
      ACTION_INTERRUPT_PATH as "/action/interrupt",
      guard(
        Effect.gen(function* () {
          const ws = yield* Workspace
          yield* ws.interrupt(sessionId)
          return noContent
        }),
      ),
    ),

    HttpRouter.post(
      "/shutdown",
      guard(
        Effect.gen(function* () {
          yield* deps.onShutdown ?? Effect.void
          return noContent
        }),
      ),
    ),

    // Workspace port failures → a 500 with the message (never a crash).
    HttpRouter.catchAll((e) =>
      HttpServerResponse.text(
        typeof e === "object" && e !== null && "message" in e ? String(e.message) : "internal error",
        { status: 500 },
      ),
    ),
  )
}
