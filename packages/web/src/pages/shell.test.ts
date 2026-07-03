import { describe, expect, test } from "bun:test"
import { renderShell } from "./shell.js"
import type { ShellView } from "../views.js"

const view: ShellView = {
  header: { sessionTitle: "s", workspace: "/w", model: "kimi", status: "idle", agentsRunning: 0 },
  blocks: [{ kind: "message", key: "m:p0:u0", role: "user", markdown: "hi" }],
  workspace: [{ kind: "file", file: { path: "a.ts", content: "x", startLine: 1 } }],
  plan: { steps: [] },
  canvas: [{ id: "arch", title: "Architecture", html: "<h1>a</h1>" }],
  activity: { status: "idle", agentsRunning: 0 },
  queue: { items: [] },
  wsUrl: "/ws?t=tok",
}

const countOf = (s: string, needle: string): number => s.split(needle).length - 1

describe("shell", () => {
  test("every region id present exactly once; rail inside the chat drawer, ws-items inside refs", () => {
    const out = renderShell(view)
    for (const id of [
      "ef-app", "ef-header", "ef-stage", "ef-tabs", "ef-canvas", "ef-stage-empty",
      "ef-chat-drawer", "ef-chat", "ef-rail", "ef-refs-drawer", "ef-ws-items",
      "ef-plan", "ef-approval", "ef-queue", "ef-reply", "ef-activity",
      "ef-composer", "ef-resync",
    ]) {
      expect(countOf(out, `id="${id}"`)).toBe(1)
    }
    // Containment: rail in the left drawer, ws-items in the right.
    const chatDrawer = out.indexOf(`id="ef-chat-drawer"`)
    const rail = out.indexOf(`id="ef-rail"`)
    const refsDrawer = out.indexOf(`id="ef-refs-drawer"`)
    const wsItems = out.indexOf(`id="ef-ws-items"`)
    expect(chatDrawer).toBeLessThan(rail)
    expect(rail).toBeLessThan(refsDrawer)
    expect(refsDrawer).toBeLessThan(wsItems)
  })

  test("the app root owns the socket and stamps the lazy mermaid source", () => {
    const out = renderShell(view)
    expect(out).toContain(`ws-connect="/ws?t=tok"`)
    expect(out).toMatch(/data-mermaid-src="\/assets\/mermaid\.min\.js[^"]*"/)
  })

  test("assets link versioned; kit.css and diagrams.js ride along", () => {
    const out = renderShell(view)
    expect(out).toMatch(/href="\/assets\/app\.css\?v=[a-z0-9]+"/)
    expect(out).toMatch(/href="\/assets\/kit\.css\?v=[a-z0-9]+"/)
    expect(out).toMatch(/src="\/assets\/app\.js\?v=[a-z0-9]+"/)
    expect(out).toContain("/assets/diagrams.js")
  })

  test("the composer carries the hidden viewing-page field seeded with the active page", () => {
    const out = renderShell(view)
    expect(out).toContain(`<input type="hidden" name="page" value="arch" />`)
    const empty = renderShell({ ...view, canvas: [] })
    expect(empty).toContain(`<input type="hidden" name="page" value="" />`)
  })

  test("the hero invites use cases via data-suggest prompts", () => {
    const out = renderShell({ ...view, canvas: [] })
    expect(countOf(out, "data-suggest=")).toBeGreaterThanOrEqual(3)
  })
})
