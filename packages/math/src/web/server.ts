/**
 * The math app's HTTP + WebSocket server — the web server's auth/assets/WS
 * skeleton with the chat send path REMOVED (no `/send`, no WS `chat` frames;
 * the student never chats) and the typed `/action/*` routes in its place.
 * Server-instant actions (check/next/reveal/report/setup) fold through
 * `pump.apply` and return 204 — the DOM change rides the WS OOB channel like
 * everything else. Agent actions (more/harder/easier/topic) coalesce while a
 * generation turn runs, drain the pending `[progress]` entries into ONE
 * machine-formatted message, and fork the turn (a failure lands as a
 * retryable error stage, never a hung request).
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import { Effect, Option, PubSub } from "effect"
import type { MathSession } from "../session.js"
import {
  ACTION_CHECK_PATH,
  ACTION_EASIER_PATH,
  ACTION_HARDER_PATH,
  ACTION_INTERRUPT_PATH,
  ACTION_MORE_PATH,
  ACTION_NEXT_PATH,
  ACTION_REPORT_PATH,
  ACTION_REVEAL_PATH,
  ACTION_SETUP_PATH,
  ACTION_TOPIC_PATH,
  MATH_EX_FIELD,
  MATH_VALUE_FIELD,
  parseClientMessage,
} from "./contract.js"
import { staticAssets } from "./static.js"
import {
  ALL_PATCHES,
  advance,
  applyGrade,
  applyReport,
  applyReveal,
  applyTopic,
  drainProgress,
  openSetup,
  setError,
  setGenerating,
  unservedCount,
  type MathModel,
} from "./model.js"
import { composeAgentMessage, type MathAction } from "../protocol.js"
import type { MathPump } from "./pump.js"
import { renderMathPage, type MathMeta } from "./render.js"

export interface MathServerIdentity {
  readonly pid: number
  readonly workspace: string
  readonly version: string
}

const COOKIE = "efmath"
/** Ask for the next batch while ≤ this many fresh exercises wait — Next stays
 *  instant because the refill lands while the student solves. */
const REFILL_AT = 2

/** The browser-level backstop behind `sanitizeMathml` (the canvas server's
 *  posture, STRICTER here: no Alpine, no Tailwind runtime — so no
 *  unsafe-eval, no unsafe-inline). Even markup that slipped the sanitizer
 *  cannot reach the network, load foreign code, or post a form off-origin. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ")

const noContent = HttpServerResponse.empty({ status: 204 })
const unauthorized = HttpServerResponse.text("unauthorized", { status: 401 })

const authed = (token: string) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    return req.cookies[COOKIE] === token
  })

/** Decode a form-encoded body into a flat string record. */
const bodyFields = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const text = yield* req.text
  return Object.fromEntries(new URLSearchParams(text).entries())
})

export const mathRouter = (deps: {
  readonly identity: MathServerIdentity
  readonly pump: MathPump
  readonly session: MathSession
  readonly meta: MathMeta
  readonly token: string
  readonly onShutdown?: Effect.Effect<void>
  /** Resolves on server shutdown — every open WS races against it. */
  readonly closed?: Effect.Effect<void>
}) => {
  const { pump, session, meta, token } = deps

  const guard = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* authed(token))) return unauthorized
      return yield* handler
    })

  /** Drain progress + flip to generating, send ONE agent-bound message in the
   *  background. Coalesces: a raced call while a turn runs is a no-op. */
  const fireAgent = (action: MathAction) =>
    Effect.gen(function* () {
      if (yield* pump.busy) return
      // Compose from the PRE state, then drain atomically: no other writer can
      // interleave (actions are serialized per request and pump.busy guards
      // re-entry), so the drained entries are exactly the composed ones.
      const before = yield* pump.snapshot
      const message = composeAgentMessage(drainProgress(before)[0], action)
      yield* pump.apply((m) => {
        const [, drained] = drainProgress(m)
        return { model: setGenerating(drained, true), patches: ALL_PATCHES }
      })
      yield* Effect.forkDetach(
        session.send(message).pipe(
          Effect.catch((e) =>
            pump
              .apply((m) => ({
                model: setError(m, "The tutor could not run.", String(e)),
                patches: ALL_PATCHES,
              }))
              .pipe(Effect.asVoid),
          ),
        ),
      )
    })

  /** Keep the buffer full: when the fresh queue runs low and nothing is
   *  generating, ask for more in the background — Next never goes dead. */
  const maybeRefill = Effect.gen(function* () {
    const m = yield* pump.snapshot
    if (m.started && !m.generating && m.lastError === undefined && unservedCount(m) <= REFILL_AT) {
      yield* fireAgent({ kind: "more" })
    }
  })

  // Failures → a 500 with the message (never a crash).
  const recover = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    handler.pipe(
      Effect.catch((e) =>
        Effect.succeed(
          HttpServerResponse.text(
            typeof e === "object" && e !== null && "message" in e ? String(e.message) : "internal error",
            { status: 500 },
          ),
        ),
      ),
    )
  const get = <E, R>(path: HttpRouter.PathInput, handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    HttpRouter.route("GET", path, recover(handler))
  const post = <E, R>(path: HttpRouter.PathInput, handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    HttpRouter.route("POST", path, recover(handler))

  const assetRoutes = staticAssets.map((asset) =>
    get(
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

  return HttpRouter.addAll([
    ...assetRoutes,
    get(
      "/health",
      HttpServerResponse.json({
        pid: deps.identity.pid,
        workspace: deps.identity.workspace,
        version: deps.identity.version,
      }).pipe(Effect.orDie),
    ),

    // The page: `?t=<token>` bootstraps the cookie; with the cookie already
    // set, a bare `/` works too. Wrong/missing token+cookie → 401.
    get(
      "/",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(req.url, "http://localhost")
        const t = url.searchParams.get("t")
        const hasCookie = req.cookies[COOKIE] === token
        if (t !== token && !hasCookie) return unauthorized
        const model = yield* pump.snapshot
        return HttpServerResponse.html(renderMathPage(model, meta)).pipe(
          HttpServerResponse.setHeader(
            "set-cookie",
            `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
          ),
          HttpServerResponse.setHeader("content-security-policy", CSP),
        )
      }),
    ),

    // The WebSocket: server→client fragments only. Client frames are
    // resync/ping — a `chat` frame is DROPPED (no chat on this product).
    get(
      "/ws",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        if (req.cookies[COOKIE] !== token) return unauthorized
        const socket = yield* req.upgrade
        yield* Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* socket.writer
            const write = (fragment: string) => writer.write(fragment)
            const sub = yield* PubSub.subscribe(pump.hub)
            yield* write(yield* pump.fullRender)
            const outbound = Effect.forever(
              PubSub.take(sub).pipe(Effect.flatMap(write)),
            )
            const onFrame = (data: string) =>
              Option.match(parseClientMessage(data), {
                onNone: () => Effect.void,
                onSome: (m) =>
                  m.type === "resync"
                    ? pump.fullRender.pipe(Effect.flatMap(write), Effect.catch(() => Effect.void))
                    : Effect.void,
              })
            // A read fails once the socket closes (cleanly or not): either way
            // the connection is over, so the race below ends with it.
            const pull = yield* Socket.readerString(socket)
            const inbound = Effect.forever(
              pull.pipe(Effect.flatMap((frames) => Effect.forEach(frames, onFrame, { discard: true }))),
            ).pipe(Effect.catch(() => Effect.void))
            yield* Effect.race(Effect.race(outbound, inbound), deps.closed ?? Effect.never)
          }),
        ).pipe(Effect.catch(() => Effect.void))
        return HttpServerResponse.empty()
      }),
    ),

    // --- server-instant actions (no agent) --------------------------------

    post(
      ACTION_CHECK_PATH as "/action/check",
      guard(
        Effect.gen(function* () {
          const fields = yield* bodyFields
          const ex = (fields[MATH_EX_FIELD] ?? "").trim()
          const value = (fields[MATH_VALUE_FIELD] ?? "").trim()
          if (ex === "" || value === "") return noContent
          yield* pump.apply((m) => {
            const r = applyGrade(m, ex, value)
            return { model: r.model, patches: r.graded ? ALL_PATCHES : [] }
          })
          yield* maybeRefill
          return noContent
        }),
      ),
    ),

    post(
      ACTION_REVEAL_PATH as "/action/reveal",
      guard(
        Effect.gen(function* () {
          const fields = yield* bodyFields
          const ex = (fields[MATH_EX_FIELD] ?? "").trim()
          if (ex !== "") {
            yield* pump.apply((m) => ({ model: applyReveal(m, ex), patches: ["stage", "controls"] }))
          }
          return noContent
        }),
      ),
    ),

    post(
      ACTION_REPORT_PATH as "/action/report",
      guard(
        Effect.gen(function* () {
          const fields = yield* bodyFields
          const ex = (fields[MATH_EX_FIELD] ?? "").trim()
          if (ex !== "") {
            yield* pump.apply((m) => ({ model: applyReport(m, ex), patches: ALL_PATCHES }))
            yield* maybeRefill
          }
          return noContent
        }),
      ),
    ),

    post(
      ACTION_NEXT_PATH as "/action/next",
      guard(
        Effect.gen(function* () {
          yield* pump.apply((m) => ({ model: advance(m), patches: ["stage", "controls"] }))
          yield* maybeRefill
          return noContent
        }),
      ),
    ),

    post(
      ACTION_SETUP_PATH as "/action/setup",
      guard(
        Effect.gen(function* () {
          yield* pump.apply((m) => ({ model: openSetup(m), patches: ["stage", "controls"] }))
          return noContent
        }),
      ),
    ),

    // --- agent actions (one turn each; coalesced while generating) --------

    post(
      ACTION_MORE_PATH as "/action/more",
      guard(fireAgent({ kind: "more" }).pipe(Effect.as(noContent))),
    ),
    post(
      ACTION_HARDER_PATH as "/action/harder",
      guard(fireAgent({ kind: "harder" }).pipe(Effect.as(noContent))),
    ),
    post(
      ACTION_EASIER_PATH as "/action/easier",
      guard(fireAgent({ kind: "easier" }).pipe(Effect.as(noContent))),
    ),

    post(
      ACTION_TOPIC_PATH as "/action/topic",
      guard(
        Effect.gen(function* () {
          const fields = yield* bodyFields
          const gradeRaw = (fields["grade"] ?? "").trim()
          const grade = /^\d+$/.test(gradeRaw) ? Number(gradeRaw) : undefined
          // A suggestion chip submits `theme`; the free-text field rides as
          // `theme-custom` (the chip wins when both arrive).
          const theme =
            (fields["theme"] ?? "").trim() !== ""
              ? (fields["theme"] ?? "").trim()
              : (fields["theme-custom"] ?? "").trim()
          const before: MathModel = yield* pump.snapshot
          if (theme === "" && before.theme === undefined) return noContent // nothing to practice yet
          // An in-flight generation is for the OLD topic — stop it first.
          if (before.generating) {
            yield* session.interrupt
            yield* pump.apply((m) => ({ model: setGenerating(m, false), patches: [] }))
          }
          yield* pump.apply((m) => ({
            model: applyTopic(m, grade, theme === "" ? undefined : theme),
            patches: ALL_PATCHES,
          }))
          yield* fireAgent({
            kind: before.started ? "topic" : "start",
            ...(grade !== undefined ? { grade } : {}),
            ...(theme !== "" ? { theme } : before.theme !== undefined ? { theme: before.theme } : {}),
          })
          return noContent
        }),
      ),
    ),

    post(
      ACTION_INTERRUPT_PATH as "/action/interrupt",
      guard(
        Effect.gen(function* () {
          yield* session.interrupt
          yield* pump.apply((m) => ({ model: setGenerating(m, false), patches: ALL_PATCHES }))
          return noContent
        }),
      ),
    ),

    post(
      "/shutdown",
      guard(
        Effect.gen(function* () {
          yield* deps.onShutdown ?? Effect.void
          return noContent
        }),
      ),
    ),
  ])
}
