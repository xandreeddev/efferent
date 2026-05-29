import { describe, expect, it } from "bun:test"
import type { Key } from "./keys.js"
import { decideKey, type NavCtx, type NavIntent } from "./navKeys.js"

// --- key constructors ---
const ch = (char: string): Key => ({ type: "char", char })
const ctrl = (char: string): Key => ({ type: "ctrl", char })
const esc: Key = { type: "escape" }
const enter: Key = { type: "enter" }
const back: Key = { type: "backspace" }
const arrow = (dir: "up" | "down" | "left" | "right"): Key => ({
  type: "arrow",
  dir,
  shift: false,
})
const pgUp: Key = { type: "pageUp" }
const pgDn: Key = { type: "pageDown" }

const ctx = (over: Partial<NavCtx>): NavCtx => ({
  focus: "input",
  mode: "insert",
  searching: false,
  searchActive: false,
  navPending: false,
  sideVisible: true,
  ...over,
})

const decide = (over: Partial<NavCtx>, key: Key): NavIntent =>
  decideKey(ctx(over), key)

describe("input pane — INSERT", () => {
  const base = { focus: "input", mode: "insert" } as const
  it("Ctrl-K focuses the conversation (and enters NORMAL there)", () => {
    expect(decide(base, ctrl("k"))).toEqual({
      kind: "focus",
      to: "conversation",
      mode: "normal",
    })
  })
  it("Ctrl-L focuses the side pane when visible", () => {
    expect(decide(base, ctrl("l"))).toEqual({
      kind: "focus",
      to: "side",
      mode: "normal",
    })
  })
  it("Ctrl-L falls through to the editor when the side pane is hidden", () => {
    expect(decide({ ...base, sideVisible: false }, ctrl("l"))).toEqual({
      kind: "input",
    })
  })
  it("Ctrl-J / Ctrl-H fall through to the editor (no pane down/left of input)", () => {
    expect(decide(base, ctrl("j"))).toEqual({ kind: "input" })
    expect(decide(base, ctrl("h"))).toEqual({ kind: "input" })
  })
  it("ordinary chars, '/', and Enter go to the editor", () => {
    expect(decide(base, ch("a"))).toEqual({ kind: "input" })
    expect(decide(base, ch("/"))).toEqual({ kind: "input" }) // literal in insert
    expect(decide(base, enter)).toEqual({ kind: "input" })
  })
  it("PgUp/PgDn page the conversation even from insert", () => {
    expect(decide(base, pgUp)).toEqual({ kind: "scroll", op: "pageUp" })
    expect(decide(base, pgDn)).toEqual({ kind: "scroll", op: "pageDown" })
  })
})

describe("input pane — NORMAL", () => {
  const base = { focus: "input", mode: "normal" } as const
  it("'/' opens search", () => {
    expect(decide(base, ch("/"))).toEqual({ kind: "openSearch" })
  })
  it("n/N cycle matches only when a search is active", () => {
    expect(decide({ ...base, searchActive: true }, ch("n"))).toEqual({
      kind: "match",
      dir: "next",
    })
    expect(decide({ ...base, searchActive: true }, ch("N"))).toEqual({
      kind: "match",
      dir: "prev",
    })
    expect(decide(base, ch("n"))).toEqual({ kind: "input" }) // no search → editor
  })
  it("Esc clears a lingering highlight, else goes to the editor", () => {
    expect(decide({ ...base, searchActive: true }, esc)).toEqual({
      kind: "clearSearch",
    })
    expect(decide(base, esc)).toEqual({ kind: "input" })
  })
  it("vi motion chars still reach the editor", () => {
    expect(decide(base, ch("j"))).toEqual({ kind: "input" })
  })
})

describe("conversation pane — NORMAL", () => {
  const base = { focus: "conversation", mode: "normal" } as const
  it("scroll motions", () => {
    expect(decide(base, ch("j"))).toEqual({ kind: "scroll", op: "lineDown" })
    expect(decide(base, ch("k"))).toEqual({ kind: "scroll", op: "lineUp" })
    expect(decide(base, ch("G"))).toEqual({ kind: "scroll", op: "bottom" })
    expect(decide(base, ch("{"))).toEqual({ kind: "scroll", op: "msgUp" })
    expect(decide(base, ch("}"))).toEqual({ kind: "scroll", op: "msgDown" })
    expect(decide(base, ctrl("d"))).toEqual({ kind: "scroll", op: "halfDown" })
    expect(decide(base, ctrl("u"))).toEqual({ kind: "scroll", op: "halfUp" })
    expect(decide(base, arrow("down"))).toEqual({ kind: "scroll", op: "lineDown" })
  })
  it("gg is a two-key motion", () => {
    expect(decide(base, ch("g"))).toEqual({ kind: "gPending" })
    expect(decide({ ...base, navPending: true }, ch("g"))).toEqual({
      kind: "scroll",
      op: "top",
    })
    // pending + a non-g key does not jump
    expect(decide({ ...base, navPending: true }, ch("x"))).toEqual({ kind: "none" })
  })
  it("'/' search, v visual, i to-input", () => {
    expect(decide(base, ch("/"))).toEqual({ kind: "openSearch" })
    expect(decide(base, ch("v"))).toEqual({ kind: "enterVisual" })
    expect(decide(base, ch("i"))).toEqual({
      kind: "focus",
      to: "input",
      mode: "insert",
    })
  })
  it("Ctrl-J → input(insert), Ctrl-L → side, Ctrl-K (no target) → none", () => {
    expect(decide(base, ctrl("j"))).toEqual({
      kind: "focus",
      to: "input",
      mode: "insert",
    })
    expect(decide(base, ctrl("l"))).toEqual({
      kind: "focus",
      to: "side",
      mode: "normal",
    })
    expect(decide(base, ctrl("k"))).toEqual({ kind: "none" })
  })
  it("Esc clears search if active, else drops to the input", () => {
    expect(decide({ ...base, searchActive: true }, esc)).toEqual({
      kind: "clearSearch",
    })
    expect(decide(base, esc)).toEqual({
      kind: "focus",
      to: "input",
      mode: "normal",
    })
  })
})

describe("conversation pane — VISUAL", () => {
  const base = { focus: "conversation", mode: "visual" } as const
  it("y yanks, v/Esc cancel", () => {
    expect(decide(base, ch("y"))).toEqual({ kind: "yank" })
    expect(decide(base, ch("v"))).toEqual({ kind: "exitVisual" })
    expect(decide(base, esc)).toEqual({ kind: "exitVisual" })
  })
  it("motions move the selection cursor", () => {
    expect(decide(base, ch("j"))).toEqual({ kind: "visualMove", op: "lineDown" })
    expect(decide(base, ch("k"))).toEqual({ kind: "visualMove", op: "lineUp" })
    expect(decide(base, ch("G"))).toEqual({ kind: "visualMove", op: "bottom" })
    expect(decide({ ...base, navPending: true }, ch("g"))).toEqual({
      kind: "visualMove",
      op: "top",
    })
    expect(decide(base, arrow("down"))).toEqual({
      kind: "visualMove",
      op: "lineDown",
    })
  })
  it("Ctrl-J still swaps to the input even from visual", () => {
    expect(decide(base, ctrl("j"))).toEqual({
      kind: "focus",
      to: "input",
      mode: "insert",
    })
  })
})

describe("search entry", () => {
  const base = { searching: true } as const
  it("chars build the query; backspace deletes", () => {
    expect(decide(base, ch("f"))).toEqual({ kind: "searchChar", char: "f" })
    expect(decide(base, back)).toEqual({ kind: "searchBack" })
  })
  it("Enter jumps, Esc cancels", () => {
    expect(decide(base, enter)).toEqual({ kind: "searchJump" })
    expect(decide(base, esc)).toEqual({ kind: "searchCancel" })
  })
  it("everything else is swallowed (no pane swap mid-query)", () => {
    expect(decide(base, ctrl("k"))).toEqual({ kind: "searchSwallow" })
    expect(decide(base, pgUp)).toEqual({ kind: "searchSwallow" })
  })
})

describe("side pane", () => {
  const base = { focus: "side", mode: "normal" } as const
  it("i → input(insert), Esc → input(normal), / → search", () => {
    expect(decide(base, ch("i"))).toEqual({
      kind: "focus",
      to: "input",
      mode: "insert",
    })
    expect(decide(base, esc)).toEqual({
      kind: "focus",
      to: "input",
      mode: "normal",
    })
    expect(decide(base, ch("/"))).toEqual({ kind: "openSearch" })
  })
  it("Ctrl-H → conversation, Ctrl-J → input", () => {
    expect(decide(base, ctrl("h"))).toEqual({
      kind: "focus",
      to: "conversation",
      mode: "normal",
    })
    expect(decide(base, ctrl("j"))).toEqual({
      kind: "focus",
      to: "input",
      mode: "insert",
    })
  })
})
