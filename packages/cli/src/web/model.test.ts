import { describe, expect, test } from "bun:test"
import { emptyModel, patchToolBlock, putBlock, putCanvas, putWorkspaceItem } from "./model.js"

const m0 = emptyModel({ phase: "idle", openToolCount: 0 })

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

  test("canvas replace swaps content; append accumulates; title survives", () => {
    const c1 = putCanvas(m0, { id: "quiz", title: "Quiz", html: "<p>q1</p>", mode: "replace" })
    expect(c1.patch).toEqual({ kind: "canvas", id: "quiz", isNew: true, focus: true })
    const c2 = putCanvas(c1.model, { id: "quiz", html: "<p>feedback</p>", mode: "append" })
    expect(c2.model.canvas[0]?.html).toBe("<p>q1</p>\n<p>feedback</p>")
    expect(c2.model.canvas[0]?.title).toBe("Quiz")
    const c3 = putCanvas(c2.model, { id: "quiz", html: "<p>fresh</p>", mode: "replace" })
    expect(c3.model.canvas[0]?.html).toBe("<p>fresh</p>")
    expect(c3.model.canvas).toHaveLength(1)
  })

  test("page focus: a NEW page focuses (unless active:false); an update only with active:true", () => {
    const a = putCanvas(m0, { id: "a", html: "<p>a</p>", mode: "replace" })
    expect(a.model.activePage).toBe("a")
    // A background-built page never steals focus…
    const b = putCanvas(a.model, { id: "b", html: "<p>b</p>", mode: "replace", active: false })
    expect(b.patch).toEqual({ kind: "canvas", id: "b", isNew: true, focus: false })
    expect(b.model.activePage).toBe("a")
    // …an ordinary update stays in the background…
    const upd = putCanvas(b.model, { id: "b", html: "<p>b2</p>", mode: "replace" })
    expect(upd.patch).toEqual({ kind: "canvas", id: "b", isNew: false, focus: false })
    expect(upd.model.activePage).toBe("a")
    // …and active:true on an update pulls the user over.
    const pull = putCanvas(upd.model, { id: "b", html: "<p>b3</p>", mode: "replace", active: true })
    expect(pull.patch).toEqual({ kind: "canvas", id: "b", isNew: false, focus: true })
    expect(pull.model.activePage).toBe("b")
  })
})
