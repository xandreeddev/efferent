import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@xandreed/sdk-core"
import { MAIN_REGION, type CanvasItemView } from "@xandreed/web"
import { replayCanvas } from "./canvasReplay.js"
import { emptyModel, putCanvas, type CanvasEntry } from "./model.js"

const regionHtml = (item: CanvasItemView | undefined, region = MAIN_REGION): string | undefined =>
  item?.regions.find((r) => r.region === region)?.html

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
  test("single render → one page (a `_main` component), focused", () => {
    const r = replayCanvas([call({ id: "arch", title: "Architecture", html: "<h1>a</h1>" })])
    expect(r.canvas).toEqual([
      { id: "arch", title: "Architecture", regions: [{ region: MAIN_REGION, html: "<h1>a</h1>" }] },
    ])
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
    expect(regionHtml(r.canvas[0])).toBe("<p>1</p>\n<p>2</p>\n<p>3</p>")
    expect(r.canvas[0]?.title).toBe("Page")
    // The last FOCUS event wins: q was a new page (focused by default).
    expect(r.activePage).toBe("q")
  })

  test("component render_ui calls replay into an ordered region structure; remove drops one", () => {
    const r = replayCanvas([
      call({ id: "home", title: "Home", region: "hero", html: "<h1>hi</h1>" }),
      call({ id: "home", region: "features", html: "<ul>f</ul>" }),
      call({ id: "home", region: "hero", html: "<h1>welcome</h1>" }), // edit in place
      call({ id: "home", region: "features", html: "", mode: "remove" }),
    ])
    expect(r.canvas).toHaveLength(1)
    expect(r.canvas[0]?.regions).toEqual([{ region: "hero", html: "<h1>welcome</h1>" }])
    expect(r.canvas[0]?.title).toBe("Home")
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
      { id: "a", region: "hero", html: "<h1>h</h1>", mode: "replace" },
      { id: "a", region: "feat", html: "<ul>f</ul>", mode: "replace" },
      { id: "a", region: "hero", html: "<h1>h2</h1>", mode: "replace" },
      { id: "b", html: "<p>b2</p>", mode: "replace", active: true },
      { id: "a", region: "feat", html: "", mode: "remove" },
      { id: "b", region: "note", html: "<i>n</i>", mode: "replace" },
    ]
    let live = emptyModel({ phase: "idle", openToolCount: 0 })
    for (const e of entries) live = putCanvas(live, e).model
    const replayed = replayCanvas(entries.map((e) => call(e)))
    expect(replayed.canvas).toEqual(live.canvas)
    expect(replayed.activePage).toBe(live.activePage as string)
  })
})
