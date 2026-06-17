/**
 * Local OAuth callback server + browser launcher for the `:login` subscription
 * flow. The provider redirects the browser to `http://localhost:<port>/callback`
 * after consent; this captures the `code`/`state` and shows a "you can close
 * this window" page. The driver races this against a manual paste of the
 * redirect URL (for headless / remote-browser cases).
 */

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>efferent</title></head>
<body style="font-family:system-ui;background:#0b0b0c;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:600">✓ Logged in</h1>
<p style="color:#9aa0a6">Authentication complete — you can close this window and return to efferent.</p></div>
</body></html>`

export interface CallbackServer {
  /** Resolves when the browser hits `/callback` with a code. */
  readonly waitForCode: Promise<{ code: string; state: string }>
  /** Shut the server down (idempotent). */
  readonly stop: () => void
}

/** Start the loopback callback server on `port`. Bun-native `Bun.serve`. */
export const startCallbackServer = (port: number, callbackPath = "/callback"): CallbackServer => {
  let resolveCode!: (v: { code: string; state: string }) => void
  const waitForCode = new Promise<{ code: string; state: string }>((resolve) => {
    resolveCode = resolve
  })
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== callbackPath) {
        return new Response("Not found", { status: 404 })
      }
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (code !== null && state !== null) {
        resolveCode({ code, state })
        return new Response(SUCCESS_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      return new Response("Missing code/state", { status: 400 })
    },
  })
  let stopped = false
  return {
    waitForCode,
    stop: () => {
      if (stopped) return
      stopped = true
      server.stop(true)
    },
  }
}

/** The platform command that opens a URL in the default browser. */
export const browserCommand = (url: string): string => {
  const u = url.replace(/"/g, "%22")
  switch (process.platform) {
    case "darwin":
      return `open "${u}"`
    case "win32":
      return `start "" "${u}"`
    default:
      return `xdg-open "${u}"`
  }
}
