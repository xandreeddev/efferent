import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { CanvasEvent } from "../session.js"
import { foldLedger } from "./server.js"

const renderEvent = (
  id: string,
  html: string,
  mode: "replace" | "append" = "replace",
  active = true,
): CanvasEvent => ({
  type: "ui_render",
  entry: { id, title: id, html, mode, active },
})

describe("the canvas model fold (replay ≡ live)", () => {
  test("internal UI protocol records never become user-facing assistant copy", () => {
    const internal = foldLedger([{ type: "assistant_message", turnIndex: 0, text: '@ui patch {"pageId":"page","blocks":[]}', reasoning: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 } }])
    expect(Option.isNone(internal.reply)).toBe(true)
  })
  test("replace swaps a page in place; append accumulates", () => {
    const model = foldLedger([
      renderEvent("a", "<p>v1</p>"),
      renderEvent("a", "<p>v2</p>"),
      renderEvent("a", "<p>+more</p>", "append"),
    ])
    expect(model.pages).toHaveLength(1)
    expect(model.pages[0]?.kind).toBe("legacy")
    expect(model.pages[0]?.kind === "legacy" ? model.pages[0].html : "").toBe("<p>v2</p><p>+more</p>")
  })

  test("focus: new pages focus by default; active:false builds in background; an update pulls focus only on explicit active:true", () => {
    const background = foldLedger([
      renderEvent("a", "x"),
      renderEvent("b", "y", "replace", false),
    ])
    expect(Option.getOrThrow(background.activeId)).toBe("a")

    const pulled = foldLedger([
      renderEvent("a", "x"),
      renderEvent("b", "y", "replace", false),
      renderEvent("b", "y2", "replace", true),
    ])
    expect(Option.getOrThrow(pulled.activeId)).toBe("b")
  })

  test("busy tracks turn boundaries; errors surface as the reply", () => {
    const mid = foldLedger([{ type: "turn_start", turnIndex: 0 }])
    expect(mid.busy).toBe(true)
    const done = foldLedger([
      { type: "turn_start", turnIndex: 0 },
      { type: "error", message: "provider down" },
    ])
    expect(done.busy).toBe(false)
    expect(Option.getOrThrow(done.reply)).toContain("provider down")
  })
})
