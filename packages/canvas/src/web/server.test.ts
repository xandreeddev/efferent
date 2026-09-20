import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ConversationId } from "@xandreed/core"
import { UiPageStore } from "@xandreed/ui-agent"
import type { CanvasSession } from "../session.js"
import { DefaultUiHostLive } from "../adapters/default-ui-host.adapter.js"
import { serveCanvas } from "./server.js"

const session = (sent: Array<string>): CanvasSession => ({
  conversationId: ConversationId.make("00000000-0000-4000-8000-000000000222"),
  send: (text) => Effect.sync(() => { sent.push(text) }),
  interrupt: Effect.void,
  state: Effect.succeed({ log: [], cursor: 0 }),
  subscribe: () => Stream.never,
  transient: Stream.never,
  shutdown: Effect.void,
})

describe("the Canvas HTTP security and shell contract", () => {
  test("serves a CSP shell without eval/Tailwind and rejects a missing CSRF token", async () => {
    const sent: Array<string> = []
    const store = { append: () => Effect.void, list: () => Effect.succeed([]) }
    const running = await Effect.runPromise(
      serveCanvas({ session: session(sent), port: 0 }).pipe(
        Effect.provide(Layer.merge(DefaultUiHostLive, Layer.succeed(UiPageStore, store))),
      ),
    )
    const page = await fetch(running.url)
    const body = await page.text()
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-eval")
    expect(body).not.toContain("tailwind")
    const rejected = await fetch(`${running.url}/action/chat`, { method: "POST", body: new URLSearchParams({ prompt: "hello" }) })
    expect(rejected.status).toBe(403)
    expect(sent).toEqual([])
    await Effect.runPromise(running.close)
  })
})

describe("the Canvas loopback origin policy", () => {
  const boot = async () => {
    const sent: Array<string> = []
    const store = { append: () => Effect.void, list: () => Effect.succeed([]) }
    const running = await Effect.runPromise(
      serveCanvas({ session: session(sent), port: 0 }).pipe(
        Effect.provide(Layer.merge(DefaultUiHostLive, Layer.succeed(UiPageStore, store))),
      ),
    )
    const shell = await (await fetch(running.url)).text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(shell)?.[1] ?? ""
    return { sent, running, csrf, origin: new URL(running.url).origin }
  }

  /** The upgrade handshake as a plain request — the server's verdict is the
   *  status: 403 refused, 101 switched. (Bun's WebSocket client reports a
   *  refused-then-accepted sequence inconsistently; the wire does not.) */
  const upgradeStatus = (url: string, origin: string): Promise<number> =>
    fetch(url, {
      headers: {
        origin,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    }).then((res) => res.status)

  test("the WebSocket upgrade is refused without a loopback Origin — the page stream is not readable cross-site", async () => {
    const { running, origin } = await boot()
    const wsUrl = `${running.url}/ws`
    expect(await upgradeStatus(wsUrl, "http://evil.example")).toBe(403)
    expect(await upgradeStatus(wsUrl, origin)).toBe(101)
    await Effect.runPromise(running.close)
  })

  test("a form post with the right CSRF token but a foreign or rebound Origin is refused; the loopback one goes through", async () => {
    const { sent, running, csrf, origin } = await boot()
    const post = (headers: Record<string, string>) =>
      fetch(`${running.url}/action/chat`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ prompt: "hello", csrf }),
      })
    expect((await post({ origin: "http://evil.example" })).status).toBe(403)
    // DNS rebinding: the attacker's hostname resolves to 127.0.0.1 — the
    // Host header says so too, and the old same-Host check let it through.
    const port = new URL(running.url).port
    expect((await post({ origin: `http://rebound.example:${port}`, host: `rebound.example:${port}` })).status).toBe(403)
    expect((await post({})).status).toBe(403)
    expect(sent).toEqual([])
    const ok = await post({ origin })
    expect(ok.status).toBeLessThan(400)
    expect(sent).toEqual(["hello"])
    await Effect.runPromise(running.close)
  })
})
