import { Deferred, Effect, Match } from "effect"
import type { Scope } from "effect"

/**
 * The loopback OAuth callback receiver — a scoped Bun.serve on 127.0.0.1
 * that resolves once with the redirect's `code`/`state` and shows a tiny
 * success page. The driver races this against a manually-pasted redirect
 * URL (the old line's proven pattern); the Scope closes the server either
 * way, so an abandoned login never leaves a port open.
 */

export interface CallbackServer {
  readonly waitForCode: Effect.Effect<{ readonly code: string; readonly state: string }>
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>efferent smith</title>
<body style="font: 16px system-ui; background: #101014; color: #e8e6e3; display: grid; place-items: center; height: 100vh">
<div>&#10003; Logged in &mdash; you can close this window and return to the terminal.</div>`

export const startCallbackServer = (
  port: number,
  path: string,
): Effect.Effect<CallbackServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const landed = yield* Deferred.make<{ readonly code: string; readonly state: string }>()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch: (req) => {
            const url = new URL(req.url)
            if (url.pathname !== path) return new Response("not found", { status: 404 })
            const code = url.searchParams.get("code") ?? ""
            const state = url.searchParams.get("state") ?? ""
            if (code.length === 0) return new Response("missing code", { status: 400 })
            Effect.runFork(Deferred.succeed(landed, { code, state }))
            return new Response(SUCCESS_PAGE, { headers: { "content-type": "text/html" } })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    return { waitForCode: Deferred.await(landed) }
  })

/** The platform's browser-open command line (the URL is OUR authorize URL,
 *  single-quoted anyway so the shell never interprets it). */
export const browserCommand = (url: string): string => {
  const quoted = `'${url.replace(/'/g, "'\\''")}'`
  return Match.value(process.platform).pipe(
    Match.when("darwin", () => `open ${quoted}`),
    Match.when("win32", () => `start "" ${quoted}`),
    Match.orElse(() => `xdg-open ${quoted}`),
  )
}
