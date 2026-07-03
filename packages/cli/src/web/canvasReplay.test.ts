import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@xandreed/sdk-core"
import { replayCanvas } from "./canvasReplay.js"
import { emptyModel, putCanvas, type CanvasEntry } from "./model.js"

const call = (input: unknown): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "x", toolName: "render_ui", input }],
  }) as AgentMessage

const otherTool: AgentMessage = {
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: "y", toolName: "read_file", input: { path: "a" } }],
} as AgentMessage

describe("canvasReplay", () => {
  test("single render → one page, focused", () => {
    const r = replayCanvas([call({ id: "arch", title: "Architecture", html: "<h1>a</h1>" })])
    expect(r.canvas).toEqual([{ id: "arch", title: "Architecture", html: "<h1>a</h1>" }])
    expect(r.activePage).toBe("arch")
  })

  test("same-id replace swaps; append accumulates in order; title sticky", () => {
    const r = replayCanvas([
      call({ id: "p", title: "Page", html: "<p>1</p>" }),
      call({ id: "p", html: "<p>2</p>", mode: "append" }),
      call({ id: "q", html: "<p>q</p>" }),
      call({ id: "p", html: "<p>3</p>", mode: "append" }),
    ])
    expect(r.canvas.map((c) => c.id)).toEqual(["p", "q"])
    expect(r.canvas[0]?.html).toBe("<p>1</p>\n<p>2</p>\n<p>3</p>")
    expect(r.canvas[0]?.title).toBe("Page")
    // The last FOCUS event wins: q was a new page (focused by default).
    expect(r.activePage).toBe("q")
  })

  test("active:false background pages never move focus; malformed inputs skip", () => {
    const r = replayCanvas([
      call({ id: "main", html: "<p>m</p>" }),
      call({ id: "bg", html: "<p>b</p>", active: false }),
      call({ html: "<p>no id</p>" }),
      call("not an object"),
      otherTool,
    ])
    expect(r.canvas.map((c) => c.id)).toEqual(["main", "bg"])
    expect(r.activePage).toBe("main")
  })

  test("EQUIVALENCE: replaying tool calls ≡ folding the same entries live through putCanvas", () => {
    const entries: ReadonlyArray<CanvasEntry> = [
      { id: "a", title: "A", html: "<p>1</p>", mode: "replace" },
      { id: "b", html: "<p>b</p>", mode: "replace", active: false },
      { id: "a", html: "<p>2</p>", mode: "append" },
      { id: "b", html: "<p>b2</p>", mode: "replace", active: true },
      { id: "a", html: "<p>fresh</p>", mode: "replace" },
    ]
    let live = emptyModel({ phase: "idle", openToolCount: 0 })
    for (const e of entries) live = putCanvas(live, e).model
    const replayed = replayCanvas(entries.map((e) => call(e)))
    expect(replayed.canvas).toEqual(live.canvas)
    expect(replayed.activePage).toBe(live.activePage as string)
  })
})
