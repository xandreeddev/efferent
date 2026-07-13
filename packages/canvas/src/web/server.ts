import { join as joinPath } from "node:path"
import { Effect, Either, Option, Ref, Stream } from "effect"
import { compileDesignTokenCss, compileThemeCss } from "@xandreed/surface"
import type { UiCompileContext } from "@xandreed/surface"
import { CORE_UI_COMPONENTS, UiComponentCatalog, UiHost, UiPageStore, applyThemeDelta, renderUiAdmissionFindings, themeFingerprint, themeIntentFromTokens, validateBlocks } from "@xandreed/ui-agent"
import type { UiComponentCatalogService, UiComponentDefinitionType, UiPageEvent, UiRequestContext } from "@xandreed/ui-agent"
import type { CanvasEvent, CanvasSession } from "../session.js"
import { emptyModel, pageId, reduceEvent } from "./state.js"
import type { CanvasModel, Page } from "./state.js"
import { renderNewPage, renderPage, renderSkeleton, renderStatus, renderTabs, wsMessage } from "./render.js"
import { renderDesignSystemShell, renderShell } from "./shell.js"

const ASSET_DIR = joinPath(import.meta.dir, "..", "..", "assets")
const ASSETS: Record<string, { readonly path: string; readonly type: string }> = {
  "/assets/htmx.min.js": { path: "vendor/htmx.min.js", type: "text/javascript" },
  "/assets/htmx-ext-ws.js": { path: "vendor/htmx-ext-ws.js", type: "text/javascript" },
  "/assets/alpine.min.js": { path: "vendor/alpine.min.js", type: "text/javascript" },
  "/assets/app.js": { path: "app.js", type: "text/javascript" },
  "/assets/catalog.js": { path: "catalog.js", type: "text/javascript" },
  "/assets/app.css": { path: "app.css", type: "text/css" },
}

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

const TOPIC = "frags"

const uiMessage = (form: FormData): string => {
  const id = String(form.get("ui-id") ?? "")
  const fields = [...form.entries()].filter(([key]) => key !== "ui-id" && key !== "csrf").map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join(" ")
  return `[ui:${id}] ${fields}`
}

const chatMessage = (form: FormData): string => {
  const prompt = String(form.get("prompt") ?? "").trim()
  const page = String(form.get("page") ?? "").trim()
  return page.length > 0 ? `[viewing:${page}] ${prompt}` : prompt
}

const sameOrigin = (req: Request): boolean => {
  const origin = req.headers.get("origin")
  return origin === null || origin === new URL(req.url).origin
}

export const serveCanvas = (args: {
  readonly session: CanvasSession
  readonly port: number
  readonly initialEvents?: ReadonlyArray<UiPageEvent>
  /** Embedded hosts resolve their authenticated principal here. Canvas omits
   * this and uses the loopback single-user context. */
  readonly requestContext?: (request: Request, csrfToken: string) => Effect.Effect<UiRequestContext, string>
}): Effect.Effect<{ readonly url: string; readonly close: Effect.Effect<void> }, never, UiHost | UiPageStore> =>
  Effect.gen(function* () {
    const host = yield* UiHost
    const pageStore = yield* UiPageStore
    const catalogOption = yield* Effect.serviceOption(UiComponentCatalog)
    const fallbackCatalog: UiComponentCatalogService = {
      list: Effect.succeed(CORE_UI_COMPONENTS),
      admit: () => Effect.fail("component admission is unavailable"),
      recordUsage: () => Effect.void,
      usages: () => Effect.succeed([]),
    }
    const catalog: UiComponentCatalogService = Option.getOrElse(catalogOption, () => fallbackCatalog)
    const csrfToken = crypto.randomUUID()
    const localContext: UiRequestContext = { sessionId: String(args.session.conversationId), principal: undefined, csrfToken }
    const initial = (args.initialEvents ?? []).reduce(reduceEvent, emptyModel)
    const model = yield* Ref.make(initial)
    const tokenCss = Either.getOrElse(compileDesignTokenCss(host.tokens), () => "")
    const initialDefinitions = yield* catalog.list.pipe(Effect.catchAll((message) => Effect.logWarning(`component catalog unavailable: ${message}`).pipe(Effect.as(CORE_UI_COMPONENTS))))
    const components = new Map<string, UiComponentDefinitionType>(initialDefinitions.map((definition) => [definition.id, definition]))
    const themeCss = new Map<string, string>()
    const baseTheme = themeIntentFromTokens(host.tokens)
    const galleryThemes = [
      { label: "Default", intent: baseTheme },
      { label: "Editorial light", intent: applyThemeDelta(baseTheme, { mode: "light", typography: "editorial", radius: "sharp", border: "strong", shadow: "none", accent: "#356dd0" }) },
      { label: "Soft product", intent: applyThemeDelta(baseTheme, { typography: "system", radius: "round", border: "subtle", shadow: "subtle", surface: "translucent", accent: "#7c5cff" }) },
      { label: "Dense operations", intent: applyThemeDelta(baseTheme, { density: "compact", typeScale: "compact", radius: "sharp", contrast: "high", border: "strong", accent: "#2a9d6f" }) },
    ].map((theme) => ({ ...theme, id: themeFingerprint(theme.intent) }))
    const galleryThemeCss = galleryThemes.map((theme) => Either.getOrElse(compileThemeCss(theme.intent, `[data-ui-theme="${theme.id}"]`), () => "")).join("\n")
    const refreshCatalog = catalog.list.pipe(
      Effect.tap((definitions) => Effect.sync(() => {
        components.clear()
        definitions.forEach((definition) => components.set(definition.id, definition))
      })),
      Effect.catchAll((message) => Effect.logWarning(`component catalog refresh failed: ${message}`)),
      Effect.asVoid,
    )
    const compileContext: UiCompileContext = { pageId: "", csrfToken, assets: host.assets, capabilities: new Set([...host.actions.keys(), ...host.queries.keys()]), components }
    const contextFor = (page: Page | undefined): UiCompileContext => {
      if (page === undefined || page.kind === "legacy") return compileContext
      const intent = page.page.manifest.theme ?? themeIntentFromTokens(host.tokens)
      const id = themeFingerprint(intent)
      const css = Either.getOrElse(compileThemeCss(intent, `[data-ui-theme="${id}"]`), () => "")
      themeCss.set(id, css)
      return { ...compileContext, pageId: page.page.manifest.id, theme: { id, href: `/theme/${id}.css` } }
    }

    const fragmentsFor = (next: CanvasModel, event: CanvasEvent, previous: CanvasModel): string => {
      if (event.type === "ui_render" || event.type === "page_opened" || event.type === "blocks_upserted" || event.type === "theme_patched" || event.type === "page_completed") {
        const id = event.type === "ui_render" ? event.entry.id : event.type === "page_opened" ? event.page.id : event.pageId
        const page = next.pages.find((candidate) => pageId(candidate) === id)
        if (page === undefined) return ""
        const isNew = !previous.pages.some((candidate) => pageId(candidate) === id)
        // A NEW page steals focus: every EXISTING section re-renders so the
        // previously-visible one picks up `hidden` — without this the view
        // stays glued to the old canvas and the new page builds invisibly.
        const others = isNew
          ? next.pages.filter((candidate) => pageId(candidate) !== id).map((candidate) => renderPage(next, candidate, true, contextFor(candidate)))
          : []
        return wsMessage([
          isNew ? renderNewPage(next, page, contextFor(page)) : renderPage(next, page, true, contextFor(page)),
          ...others,
          renderSkeleton(false),
          renderTabs(next, true),
          renderStatus(next, true),
        ])
      }
      if (event.type === "turn_start") {
        return wsMessage([renderSkeleton(true), renderStatus(next, true)])
      }
      if (event.type === "agent_end" || event.type === "error") {
        return wsMessage([renderSkeleton(false), renderStatus(next, true)])
      }
      return wsMessage([renderStatus(next, true)])
    }

    const fullSync = (current: CanvasModel): string => wsMessage([
      ...current.pages.map((page) => renderNewPage(current, page, contextFor(page))),
      renderTabs(current, true),
      renderStatus(current, true),
    ])

    const applyEvent = (event: UiPageEvent, server: ReturnType<typeof Bun.serve>): Effect.Effect<void> =>
      Ref.get(model).pipe(
        Effect.flatMap((current) => {
          if (event.type !== "blocks_upserted") return Effect.void
          const page = current.pages.find((candidate) => candidate.kind === "structured" && candidate.page.manifest.id === event.pageId)
          if (page?.kind !== "structured") return Effect.fail(`host action targeted missing page ${event.pageId}`)
          const findings = validateBlocks(page.page.manifest, event.blocks, host, components)
          return findings.length === 0 ? Effect.void : Effect.fail(`host action patch rejected:\n${renderUiAdmissionFindings(findings)}`)
        }),
        Effect.zipRight(pageStore.append(args.session.conversationId, event)),
        Effect.flatMap(() => Ref.modify(model, (previous) => {
          const next = reduceEvent(previous, event)
          return [{ previous, next }, next] as const
        })),
        Effect.map(({ previous, next }) => void server.publish(TOPIC, fragmentsFor(next, event, previous))),
        Effect.catchAll((error) => Effect.logError(`host action persistence failed: ${error}`)),
      )

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: args.port,
      fetch: (req, srv) => {
        const url = new URL(req.url)
        if (url.pathname === "/ws" && srv.upgrade(req)) return undefined
        if (url.pathname === "/") return new Response(renderShell(csrfToken), { headers: { "content-type": "text/html", "content-security-policy": CSP } })
        if (url.pathname === "/design-system") return new Response(renderDesignSystemShell([...components.values()], compileContext, galleryThemes.map(({ id, label }) => ({ id, label }))), { headers: { "content-type": "text/html", "content-security-policy": CSP } })
        if (url.pathname === "/assets/theme.css") return new Response(tokenCss, { headers: { "content-type": "text/css", "cache-control": "no-store" } })
        if (url.pathname === "/assets/catalog-themes.css") return new Response(galleryThemeCss, { headers: { "content-type": "text/css", "cache-control": "no-store" } })
        const themeMatch = url.pathname.match(/^\/theme\/([a-z0-9-]+)\.css$/)
        if (themeMatch !== null) {
          const css = themeCss.get(themeMatch[1] ?? "")
          return css === undefined ? new Response("theme not found", { status: 404 }) : new Response(css, { headers: { "content-type": "text/css", "cache-control": "public, max-age=31536000, immutable" } })
        }
        const asset = ASSETS[url.pathname]
        if (asset !== undefined) return new Response(Bun.file(joinPath(ASSET_DIR, asset.path)), { headers: { "content-type": asset.type } })
        if (req.method === "POST" && (url.pathname === "/action/chat" || url.pathname === "/action/ui")) {
          if (!sameOrigin(req)) return new Response("origin rejected", { status: 403 })
          return req.formData().then((form) => {
            if (String(form.get("csrf") ?? "") !== csrfToken) return new Response("csrf rejected", { status: 403 })
            const text = url.pathname === "/action/chat" ? chatMessage(form) : uiMessage(form)
            if (text.length > 0) Effect.runFork(args.session.send(text))
            return new Response(null, { status: 204 })
          })
        }
        if (req.method === "POST" && url.pathname === "/action/host") {
          if (!sameOrigin(req)) return new Response("origin rejected", { status: 403 })
          return req.formData().then((form) => {
            if (String(form.get("csrf") ?? "") !== csrfToken) return new Response("csrf rejected", { status: 403 })
            const capabilityId = String(form.get("capability") ?? "")
            const pageIdValue = String(form.get("page-id") ?? "")
            const capability = host.actions.get(capabilityId) ?? host.queries.get(capabilityId)
            if (capability === undefined) return new Response("capability not found", { status: 404 })
            const input = Object.fromEntries([...form.entries()].filter(([key]) => !["csrf", "capability", "page-id"].includes(key)).map(([key, value]) => [key, String(value)]))
            const context = args.requestContext === undefined ? Effect.succeed(localContext) : args.requestContext(req, csrfToken)
            Effect.runFork(
              context.pipe(
                Effect.flatMap((resolved) => capability.decode(input).pipe(Effect.map((decoded) => ({ decoded, resolved })))),
                Effect.flatMap(({ decoded, resolved }) => capability.authorize(decoded, resolved).pipe(Effect.as({ decoded, resolved }))),
                Effect.flatMap(({ decoded, resolved }) => capability.run(decoded, resolved)),
                Effect.flatMap((result) => result.blocks.length === 0 ? Effect.void : applyEvent({ type: "blocks_upserted", pageId: pageIdValue, blocks: result.blocks, at: Date.now() }, server)),
                Effect.catchAll((error) => Effect.logWarning(`host capability rejected: ${error}`)),
              ),
            )
            return new Response(null, { status: 202 })
          })
        }
        return new Response("not found", { status: 404 })
      },
      websocket: {
        open: (ws) => {
          ws.subscribe(TOPIC)
          void Effect.runPromise(refreshCatalog.pipe(Effect.zipRight(Ref.get(model)), Effect.map((current) => void ws.send(fullSync(current)))))
        },
        message: () => {},
        close: (ws) => void ws.unsubscribe(TOPIC),
      },
    })

    yield* Effect.forkDaemon(Stream.runForEach(args.session.subscribe(0), (seq) => refreshCatalog.pipe(Effect.zipRight(Ref.modify(model, (previous) => {
      const next = reduceEvent(previous, seq.event)
      return [{ previous, next }, next] as const
    })), Effect.map(({ previous, next }) => {
      const fragments = fragmentsFor(next, seq.event, previous)
      if (fragments.length > 0) server.publish(TOPIC, fragments)
    }))))
    return { url: `http://127.0.0.1:${server.port}`, close: Effect.sync(() => void server.stop(true)) }
  })

export const foldLedger = (events: ReadonlyArray<CanvasEvent>): CanvasModel => events.reduce(reduceEvent, emptyModel)
export const activePageId = (model: CanvasModel): string => Option.getOrElse(model.activeId, () => "")
