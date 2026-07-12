import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ConversationId } from "@xandreed/engine"
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
