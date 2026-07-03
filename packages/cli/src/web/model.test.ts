import { describe, expect, test } from "bun:test"
import { MAIN_REGION, type CanvasItemView } from "@xandreed/web"
import { emptyModel, patchToolBlock, putBlock, putCanvas, putWorkspaceItem } from "./model.js"

const m0 = emptyModel({ phase: "idle", openToolCount: 0 })

/** Read one component's html (or the whole-page `_main`). */
const regionHtml = (item: CanvasItemView | undefined, region = MAIN_REGION): string | undefined =>
  item?.regions.find((r) => r.region === region)?.html

describe("web model — keyed cache semantics", () => {
  test("keyed blocks upsert in place (idempotent); transients mint fresh keys", () => {
    const a = putBlock(m0, { kind: "assistant", text: "one", key: "m:p3:a0" })
    expect(a.patch).toEqual({ kind: "block", key: "m:p3:a0", isNew: true })
    const b = putBlock(a.model, { kind: "assistant", text: "one refined", key: "m:p3:a0" })
    expect(b.patch.kind === "block" && !b.patch.isNew).toBe(true)
    expect(b.model.blocks).toHaveLength(1)
    expect(b.model.blocks[0]?.block.kind === "assistant" && b.model.blocks[0].block.text).toBe(
      "one refined",
    )

    const i1 = putBlock(b.model, { kind: "info", text: "note" })
    const i2 = putBlock(i1.model, { kind: "info", text: "note" }) // same text, distinct entries
    expect(i2.model.blocks).toHaveLength(3)
    expect(i1.patch.kind === "block" && i1.patch.key).not.toBe(
      i2.patch.kind === "block" && i2.patch.key,
    )
  })

  test("tool pills key on their id and patch in place", () => {
    const t = putBlock(m0, { kind: "tool", id: "call-1", toolName: "read_file(a.ts)", state: "running" })
    const done = patchToolBlock(t.model, "call-1", { state: "ok", detail: "12 lines" })
    expect(done.patch).toEqual({ kind: "block", key: "call-1", isNew: false })
    const pill = done.model.blocks[0]?.block
    expect(pill?.kind === "tool" && pill.state).toBe("ok")
    expect(patchToolBlock(m0, "missing", { state: "ok" }).patch).toBeUndefined()
  })

  test("workspace file cards key by path (a re-read refreshes in place)", () => {
    const f1 = putWorkspaceItem(m0, { kind: "file", file: { path: "a.ts", content: "v1", startLine: 1 } })
    expect(f1.patch).toEqual({ kind: "workspace", index: 0, isNew: true })
    const f2 = putWorkspaceItem(f1.model, { kind: "file", file: { path: "a.ts", content: "v2", startLine: 1 } })
    expect(f2.patch).toEqual({ kind: "workspace", index: 0, isNew: false })
    expect(f2.model.workspace).toHaveLength(1)
    const d = putWorkspaceItem(f2.model, {
      kind: "diff",
      diff: { id: "c9", path: "a.ts", diff: "+x", added: 1, removed: 0 },
    })
    expect(d.patch).toEqual({ kind: "workspace", index: 1, isNew: true })
  })

  test("plan items route to the plan slot, not the card stack", () => {
    const p = putWorkspaceItem(m0, { kind: "plan", plan: { steps: [{ text: "one", status: "todo" }] } })
    expect(p.patch).toEqual({ kind: "plan" })
    expect(p.model.workspace).toHaveLength(0)
    expect(p.model.plan).toEqual([{ step: "one", status: "pending" }])
  })

  test("whole-page (no region) replace/append fold through the `_main` component; title survives", () => {
    const c1 = putCanvas(m0, { id: "quiz", title: "Quiz", html: "<p>q1</p>", mode: "replace" })
    expect(c1.patch).toEqual({ kind: "canvas", id: "quiz", region: MAIN_REGION, op: "new-page", focus: true })
    expect(regionHtml(c1.model.canvas[0])).toBe("<p>q1</p>")
    const c2 = putCanvas(c1.model, { id: "quiz", html: "<p>feedback</p>", mode: "append" })
    expect(regionHtml(c2.model.canvas[0])).toBe("<p>q1</p>\n<p>feedback</p>")
    expect(c2.model.canvas[0]?.title).toBe("Quiz")
    const c3 = putCanvas(c2.model, { id: "quiz", html: "<p>fresh</p>", mode: "replace" })
    expect(c3.patch.kind === "canvas" && c3.patch.op).toBe("rebuild")
    expect(regionHtml(c3.model.canvas[0])).toBe("<p>fresh</p>")
    expect(c3.model.canvas[0]?.regions).toHaveLength(1)
    expect(c3.model.canvas).toHaveLength(1)
  })

  test("component streaming: editing one region leaves the others byte-identical", () => {
    // Build a page as three components…
    let m = putCanvas(m0, { id: "home", region: "hero", html: "<h1>Home</h1>" }).model
    let last = putCanvas(m, { id: "home", region: "features", html: "<ul>f</ul>" })
    expect(last.patch.kind === "canvas" && last.patch.op).toBe("new-region")
    m = last.model
    m = putCanvas(m, { id: "home", region: "stats", html: "<div>42</div>" }).model
    const before = m.canvas[0]!
    expect(before.regions.map((r) => r.region)).toEqual(["hero", "features", "stats"])

    // …then edit ONLY the hero.
    const edit = putCanvas(m, { id: "home", region: "hero", html: "<h1>Welcome</h1>" })
    expect(edit.patch).toEqual({ kind: "canvas", id: "home", region: "hero", op: "update-region", focus: false })
    const after = edit.model.canvas[0]!
    expect(regionHtml(after, "hero")).toBe("<h1>Welcome</h1>")
    // The untouched components are the SAME objects (no clobber, insertion order held).
    expect(regionHtml(after, "features")).toBe(regionHtml(before, "features"))
    expect(regionHtml(after, "stats")).toBe(regionHtml(before, "stats"))
    expect(after.regions.map((r) => r.region)).toEqual(["hero", "features", "stats"])
  })

  test("append grows one region; remove drops it (other components untouched)", () => {
    let m = putCanvas(m0, { id: "p", region: "log", html: "line 1" }).model
    m = putCanvas(m, { id: "p", region: "aside", html: "<i>note</i>" }).model
    const grow = putCanvas(m, { id: "p", region: "log", html: "line 2", mode: "append" })
    expect(regionHtml(grow.model.canvas[0], "log")).toBe("line 1\nline 2")
    const drop = putCanvas(grow.model, { id: "p", region: "log", html: "", mode: "remove" })
    expect(drop.patch.kind === "canvas" && drop.patch.op).toBe("remove-region")
    expect(drop.model.canvas[0]?.regions.map((r) => r.region)).toEqual(["aside"])
    expect(regionHtml(drop.model.canvas[0], "aside")).toBe("<i>note</i>")
  })

  test("a no-region replace rebuilds a component page down to a single `_main`", () => {
    let m = putCanvas(m0, { id: "p", region: "hero", html: "<h1>a</h1>" }).model
    m = putCanvas(m, { id: "p", region: "body", html: "<p>b</p>" }).model
    const rebuilt = putCanvas(m, { id: "p", html: "<main>fresh</main>", mode: "replace" })
    expect(rebuilt.patch.kind === "canvas" && rebuilt.patch.op).toBe("rebuild")
    expect(rebuilt.model.canvas[0]?.regions).toEqual([{ region: MAIN_REGION, html: "<main>fresh</main>" }])
  })

  test("page focus: a NEW page focuses (unless active:false); an update only with active:true", () => {
    const a = putCanvas(m0, { id: "a", html: "<p>a</p>", mode: "replace" })
    expect(a.model.activePage).toBe("a")
    // A background-built page never steals focus…
    const b = putCanvas(a.model, { id: "b", html: "<p>b</p>", mode: "replace", active: false })
    expect(b.patch).toEqual({ kind: "canvas", id: "b", region: MAIN_REGION, op: "new-page", focus: false })
    expect(b.model.activePage).toBe("a")
    // …an ordinary region update stays in the background…
    const upd = putCanvas(b.model, { id: "b", region: "x", html: "<p>b2</p>" })
    expect(upd.patch).toEqual({ kind: "canvas", id: "b", region: "x", op: "new-region", focus: false })
    expect(upd.model.activePage).toBe("a")
    // …and active:true on an update pulls the user over.
    const pull = putCanvas(upd.model, { id: "b", region: "x", html: "<p>b3</p>", active: true })
    expect(pull.patch).toEqual({ kind: "canvas", id: "b", region: "x", op: "update-region", focus: true })
    expect(pull.model.activePage).toBe("b")
  })
})
