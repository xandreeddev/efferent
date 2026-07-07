import { join as joinPath } from "node:path"
import { Effect, Option, Ref, Stream } from "effect"
import type { CanvasEvent, CanvasSession } from "../session.js"
import { emptyModel, reduceEvent } from "./state.js"
import type { CanvasModel } from "./state.js"
import { renderNewPage, renderPage, renderStatus, renderTabs, wsMessage } from "./render.js"
import { renderShell } from "./shell.js"

/**
 * The canvas driver: ONE pump fiber folds the session ledger into a model
 * Ref and broadcasts each event's fragments to every socket (topic pub/sub);
 * a socket that connects gets one full sync from the current model —
 * idempotent by construction, no client cursor. Binds 127.0.0.1 only
 * (v1 simplification: no boot token; localhost is the boundary).
 */

const ASSET_DIR = joinPath(import.meta.dir, "..", "..", "assets")
const ASSETS: Record<string, { readonly path: string; readonly type: string }> = {
  "/assets/htmx.min.js": { path: "vendor/htmx.min.js", type: "text/javascript" },
  "/assets/htmx-ext-ws.js": { path: "vendor/htmx-ext-ws.js", type: "text/javascript" },
  "/assets/tailwind.min.js": { path: "vendor/tailwind.min.js", type: "text/javascript" },
  "/assets/app.js": { path: "app.js", type: "text/javascript" },
  "/assets/app.css": { path: "app.css", type: "text/css" },
}

const TOPIC = "frags"

const fragmentsFor = (model: CanvasModel, event: CanvasEvent, prev: CanvasModel): string => {
  if (event.type === "ui_render") {
    const page = model.pages.find((p) => p.id === event.entry.id)
    if (page === undefined) return ""
    const isNew = !prev.pages.some((p) => p.id === event.entry.id)
    return wsMessage([
      isNew ? renderNewPage(model, page) : renderPage(model, page, true),
      renderTabs(model, true),
      renderStatus(model, true),
    ])
  }
  return wsMessage([renderStatus(model, true)])
}

const fullSync = (model: CanvasModel): string =>
  wsMessage([
    ...model.pages.map((p) => renderNewPage(model, p)),
    renderTabs(model, true),
    renderStatus(model, true),
  ])

const uiMessage = (form: FormData): string => {
  const id = String(form.get("ui-id") ?? "")
  const fields = [...form.entries()]
    .filter(([k]) => k !== "ui-id")
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(" ")
  return `[ui:${id}] ${fields}`
}

const chatMessage = (form: FormData): string => {
  const prompt = String(form.get("prompt") ?? "").trim()
  const page = String(form.get("page") ?? "").trim()
  return page.length > 0 ? `[viewing:${page}] ${prompt}` : prompt
}

export const serveCanvas = (args: {
  readonly session: CanvasSession
  readonly port: number
}): Effect.Effect<{ readonly url: string }, never, never> =>
  Effect.gen(function* () {
    const model = yield* Ref.make(emptyModel)

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: args.port,
      fetch: (req, srv) => {
        const url = new URL(req.url)
        if (url.pathname === "/ws" && srv.upgrade(req)) return undefined
        if (url.pathname === "/") {
          return new Response(renderShell(), { headers: { "content-type": "text/html" } })
        }
        const asset = ASSETS[url.pathname]
        if (asset !== undefined) {
          return new Response(Bun.file(joinPath(ASSET_DIR, asset.path)), {
            headers: { "content-type": asset.type },
          })
        }
        if (req.method === "POST" && url.pathname === "/action/chat") {
          return req.formData().then((form) => {
            const text = chatMessage(form)
            if (text.length > 0) {
              void Effect.runPromise(Effect.fork(args.session.send(text)))
            }
            return new Response(null, { status: 204 })
          })
        }
        if (req.method === "POST" && url.pathname === "/action/ui") {
          return req.formData().then((form) => {
            void Effect.runPromise(Effect.fork(args.session.send(uiMessage(form))))
            return new Response(null, { status: 204 })
          })
        }
        return new Response("not found", { status: 404 })
      },
      websocket: {
        open: (ws) => {
          ws.subscribe(TOPIC)
          void Effect.runPromise(
            Ref.get(model).pipe(Effect.map((m) => void ws.send(fullSync(m)))),
          )
        },
        message: () => {},
        close: (ws) => void ws.unsubscribe(TOPIC),
      },
    })

    // The pump: fold every ledger event (replay + live) into the model and
    // broadcast its fragments.
    yield* Effect.forkDaemon(
      Stream.runForEach(args.session.subscribe(0), (seq) =>
        Ref.get(model).pipe(
          Effect.flatMap((prev) => {
            const next = reduceEvent(prev, seq.event)
            const frags = fragmentsFor(next, seq.event, prev)
            return Ref.set(model, next).pipe(
              Effect.map(() => {
                if (frags.length > 0) server.publish(TOPIC, frags)
              }),
            )
          }),
        ),
      ),
    )

    return { url: `http://127.0.0.1:${server.port}` }
  })

/** Replay-safe model rebuild for tests: fold a whole ledger. */
export const foldLedger = (
  events: ReadonlyArray<CanvasEvent>,
): CanvasModel => events.reduce(reduceEvent, emptyModel)

export const activePageId = (model: CanvasModel): string =>
  Option.getOrElse(model.activeId, () => "")
