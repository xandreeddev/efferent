import { describe, expect, it } from "bun:test"
import type { Key } from "./keys.js"
import { decideKey, type NavCtx, type NavIntent } from "./navKeys.js"

// --- key constructors ---
const ch = (char: string): Key => ({ type: "char", char })
const ctrl = (char: string): Key => ({ type: "ctrl", char })
const esc: Key = { type: "escape" }
const enter: Key = { type: "enter" }
const tab: Key = { type: "tab" }
const back: Key = { type: "backspace" }
const arrow = (
  dir: "up" | "down" | "left" | "right",
  ctrl = false,
): Key => ({ type: "arrow", dir, shift: false, ctrl })
const pgUp: Key = { type: "pageUp" }
const pgDn: Key = { type: "pageDown" }
const home: Key = { type: "home" }
const end: Key = { type: "end" }

const ctx = (over: Partial<NavCtx>): NavCtx => ({
  focus: "input",
  mode: "insert",
  entry: "message",
  inputEmpty: true,
  searchActive: false,
  navPending: false,
  sideVisible: true,
  zoomed: false,
  view: "stack",
  ...over,
})

const decide = (over: Partial<NavCtx>, key: Key): NavIntent =>
  decideKey(ctx(over), key)

describe("input pane — INSERT (message)", () => {
  const base = { focus: "input", mode: "insert" } as const
  it("`:` / `/` open command/search on an empty buffer", () => {
    expect(decide(base, ch(":"))).toEqual({ kind: "openCommand" })
    expect(decide(base, ch("/"))).toEqual({ kind: "openSearch" })
  })
  it("`:` / `/` are literal mid-message (non-empty buffer)", () => {
    expect(decide({ ...base, inputEmpty: false }, ch(":"))).toEqual({ kind: "input" })
    expect(decide({ ...base, inputEmpty: false }, ch("/"))).toEqual({ kind: "input" })
  })
  it("Ctrl-K → conversation, Ctrl-L → side, Ctrl-J/Ctrl-H → editor", () => {
    expect(decide(base, ctrl("k"))).toEqual({ kind: "focus", to: "conversation", mode: "normal" })
    expect(decide(base, ctrl("l"))).toEqual({ kind: "focus", to: "side", mode: "normal" })
    expect(decide({ ...base, sideVisible: false }, ctrl("l"))).toEqual({ kind: "input" })
    expect(decide(base, ctrl("j"))).toEqual({ kind: "input" })
    expect(decide(base, ctrl("h"))).toEqual({ kind: "input" })
  })
  it("ordinary chars / Enter go to the editor; PgUp pages the chat", () => {
    expect(decide(base, ch("a"))).toEqual({ kind: "input" })
    expect(decide(base, enter)).toEqual({ kind: "input" })
    expect(decide(base, pgUp)).toEqual({ kind: "scroll", op: "pageUp" })
    expect(decide(base, pgDn)).toEqual({ kind: "scroll", op: "pageDown" })
  })
})

describe("input pane — NORMAL", () => {
  const base = { focus: "input", mode: "normal" } as const
  it("`:` command, `/` search", () => {
    expect(decide(base, ch(":"))).toEqual({ kind: "openCommand" })
    expect(decide(base, ch("/"))).toEqual({ kind: "openSearch" })
  })
  it("n/N cycle matches only when a search is active", () => {
    expect(decide({ ...base, searchActive: true }, ch("n"))).toEqual({ kind: "match", dir: "next" })
    expect(decide({ ...base, searchActive: true }, ch("N"))).toEqual({ kind: "match", dir: "prev" })
    expect(decide(base, ch("n"))).toEqual({ kind: "input" })
  })
  it("Esc clears a lingering highlight, else goes to the editor", () => {
    expect(decide({ ...base, searchActive: true }, esc)).toEqual({ kind: "clearSearch" })
    expect(decide(base, esc)).toEqual({ kind: "input" })
  })
  it("vi motion chars still reach the editor", () => {
    expect(decide(base, ch("j"))).toEqual({ kind: "input" })
  })
})

describe("command-line entry (command / search)", () => {
  for (const entry of ["command", "search"] as const) {
    it(`${entry}: chars/backspace edit the body; Enter submits; Esc cancels`, () => {
      const base = { focus: "input", entry } as const
      expect(decide(base, ch("x"))).toEqual({ kind: "entryEdit" })
      expect(decide(base, back)).toEqual({ kind: "entryEdit" })
      expect(decide(base, enter)).toEqual({ kind: "entrySubmit" })
      expect(decide(base, esc)).toEqual({ kind: "entryCancel" })
      // Ctrl-K does not swap panes mid-entry; it edits the body.
      expect(decide(base, ctrl("k"))).toEqual({ kind: "entryEdit" })
    })
  }
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
  it("gg jumps to the top", () => {
    expect(decide(base, ch("g"))).toEqual({ kind: "gPending" })
    expect(decide({ ...base, navPending: true }, ch("g"))).toEqual({ kind: "scroll", op: "top" })
    expect(decide({ ...base, navPending: true }, ch("x"))).toEqual({ kind: "none" })
  })
  it("`/` search, `:` command, v visual, i to-input", () => {
    expect(decide(base, ch("/"))).toEqual({ kind: "openSearch" })
    expect(decide(base, ch(":"))).toEqual({ kind: "openCommand" })
    expect(decide(base, ch("v"))).toEqual({ kind: "enterVisual" })
    expect(decide(base, ch("i"))).toEqual({ kind: "focus", to: "input", mode: "insert" })
  })
  it("z toggles zoom", () => {
    expect(decide(base, ch("z"))).toEqual({ kind: "toggleZoom" })
  })
  it("Ctrl-J → input(insert), Ctrl-L → side, Ctrl-K (no target) → none", () => {
    expect(decide(base, ctrl("j"))).toEqual({ kind: "focus", to: "input", mode: "insert" })
    expect(decide(base, ctrl("l"))).toEqual({ kind: "focus", to: "side", mode: "normal" })
    expect(decide(base, ctrl("k"))).toEqual({ kind: "none" })
  })
  it("Esc unwinds zoom first, then search, then drops to the input", () => {
    expect(decide({ ...base, zoomed: true }, esc)).toEqual({ kind: "toggleZoom" })
    expect(decide({ ...base, zoomed: true, searchActive: true }, esc)).toEqual({ kind: "toggleZoom" })
    expect(decide({ ...base, searchActive: true }, esc)).toEqual({ kind: "clearSearch" })
    expect(decide(base, esc)).toEqual({ kind: "focus", to: "input", mode: "normal" })
  })
})

describe("conversation pane — VISUAL", () => {
  const base = { focus: "conversation", mode: "visual" } as const
  it("y yanks, v/Esc cancel", () => {
    expect(decide(base, ch("y"))).toEqual({ kind: "yank" })
    expect(decide(base, ch("v"))).toEqual({ kind: "exitVisual" })
    expect(decide(base, esc)).toEqual({ kind: "exitVisual" })
  })
  it("motions move the cursor (which extends the selection)", () => {
    expect(decide(base, ch("j"))).toEqual({ kind: "scroll", op: "lineDown" })
    expect(decide(base, ch("k"))).toEqual({ kind: "scroll", op: "lineUp" })
    expect(decide(base, ch("G"))).toEqual({ kind: "scroll", op: "bottom" })
    expect(decide({ ...base, navPending: true }, ch("g"))).toEqual({ kind: "scroll", op: "top" })
    expect(decide(base, ctrl("d"))).toEqual({ kind: "scroll", op: "halfDown" })
    expect(decide(base, arrow("down"))).toEqual({ kind: "scroll", op: "lineDown" })
  })
  it("Ctrl-J still swaps to the input even from visual", () => {
    expect(decide(base, ctrl("j"))).toEqual({ kind: "focus", to: "input", mode: "insert" })
  })
})

describe("side pane", () => {
  const base = { focus: "side", mode: "normal" } as const
  it("i → input(insert), Esc → input(normal), `:`/`/` open command/search", () => {
    expect(decide(base, ch("i"))).toEqual({ kind: "focus", to: "input", mode: "insert" })
    expect(decide(base, esc)).toEqual({ kind: "focus", to: "input", mode: "normal" })
    expect(decide(base, ch(":"))).toEqual({ kind: "openCommand" })
    expect(decide(base, ch("/"))).toEqual({ kind: "openSearch" })
  })
  it("Ctrl-H → conversation, Ctrl-J → input", () => {
    expect(decide(base, ctrl("h"))).toEqual({ kind: "focus", to: "conversation", mode: "normal" })
    expect(decide(base, ctrl("j"))).toEqual({ kind: "focus", to: "input", mode: "insert" })
  })
  it("z toggles zoom", () => {
    expect(decide(base, ch("z"))).toEqual({ kind: "toggleZoom" })
  })
})

describe("conversation pane — block-cursor motions", () => {
  const base = { focus: "conversation", mode: "normal" } as const
  it("h/l → char left/right; arrows too", () => {
    expect(decide(base, ch("h"))).toEqual({ kind: "cursorMove", op: "charLeft" })
    expect(decide(base, ch("l"))).toEqual({ kind: "cursorMove", op: "charRight" })
    expect(decide(base, arrow("left"))).toEqual({ kind: "cursorMove", op: "charLeft" })
    expect(decide(base, arrow("right"))).toEqual({ kind: "cursorMove", op: "charRight" })
  })
  it("0/^/$ → line ends", () => {
    expect(decide(base, ch("0"))).toEqual({ kind: "cursorMove", op: "lineStart" })
    expect(decide(base, ch("^"))).toEqual({ kind: "cursorMove", op: "firstNonBlank" })
    expect(decide(base, ch("$"))).toEqual({ kind: "cursorMove", op: "lineEnd" })
  })
  it("w/b/e and W/B/E → word motions", () => {
    expect(decide(base, ch("w"))).toEqual({ kind: "cursorMove", op: "wordFwd" })
    expect(decide(base, ch("b"))).toEqual({ kind: "cursorMove", op: "wordBack" })
    expect(decide(base, ch("e"))).toEqual({ kind: "cursorMove", op: "wordEnd" })
    expect(decide(base, ch("W"))).toEqual({ kind: "cursorMove", op: "wordFwdBig" })
    expect(decide(base, ch("B"))).toEqual({ kind: "cursorMove", op: "wordBackBig" })
    expect(decide(base, ch("E"))).toEqual({ kind: "cursorMove", op: "wordEndBig" })
  })
  it("v charwise / V linewise VISUAL; j/k still line scroll", () => {
    expect(decide(base, ch("v"))).toEqual({ kind: "enterVisual" })
    expect(decide(base, ch("V"))).toEqual({ kind: "enterVisualLine" })
    expect(decide(base, ch("j"))).toEqual({ kind: "scroll", op: "lineDown" })
    expect(decide(base, ch("k"))).toEqual({ kind: "scroll", op: "lineUp" })
  })
  it("Tab/Enter fold the section under the cursor; Z folds all", () => {
    expect(decide(base, tab)).toEqual({ kind: "foldToggle" })
    expect(decide(base, enter)).toEqual({ kind: "foldToggle" })
    expect(decide(base, ch("Z"))).toEqual({ kind: "foldAll" })
  })
  it("VISUAL: motions extend the selection (h/l/w + j/k)", () => {
    const v = { focus: "conversation", mode: "visual" } as const
    expect(decide(v, ch("l"))).toEqual({ kind: "cursorMove", op: "charRight" })
    expect(decide(v, ch("w"))).toEqual({ kind: "cursorMove", op: "wordFwd" })
    expect(decide(v, ch("j"))).toEqual({ kind: "scroll", op: "lineDown" })
    expect(decide(v, ch("y"))).toEqual({ kind: "yank" })
  })
})

describe("Ctrl-arrows mirror Ctrl-hjkl for pane focus", () => {
  it("from the input: Ctrl-↑ → conversation, Ctrl-→ → side", () => {
    const base = { focus: "input", mode: "insert" } as const
    expect(decide(base, arrow("up", true))).toEqual({ kind: "focus", to: "conversation", mode: "normal" })
    expect(decide(base, arrow("right", true))).toEqual({ kind: "focus", to: "side", mode: "normal" })
    // no pane below/left of the input → Ctrl-arrow falls back to the editor.
    expect(decide(base, arrow("down", true))).toEqual({ kind: "input" })
    expect(decide(base, arrow("left", true))).toEqual({ kind: "input" })
    // no side pane → Ctrl-→ also falls back.
    expect(decide({ ...base, sideVisible: false }, arrow("right", true))).toEqual({ kind: "input" })
  })
  it("from the conversation: Ctrl-↓ → input, Ctrl-→ → side, Ctrl-↑ falls back to scroll", () => {
    const base = { focus: "conversation", mode: "normal" } as const
    expect(decide(base, arrow("down", true))).toEqual({ kind: "focus", to: "input", mode: "insert" })
    expect(decide(base, arrow("right", true))).toEqual({ kind: "focus", to: "side", mode: "normal" })
    expect(decide(base, arrow("up", true))).toEqual({ kind: "scroll", op: "lineUp" })
  })
  it("works from VISUAL too (Ctrl-↓ → input)", () => {
    expect(decide({ focus: "conversation", mode: "visual" }, arrow("down", true))).toEqual({
      kind: "focus",
      to: "input",
      mode: "insert",
    })
  })
  it("from the side pane: Ctrl-← → conversation, Ctrl-↓ → input", () => {
    const base = { focus: "side", mode: "normal", view: "stack" } as const
    expect(decide(base, arrow("left", true))).toEqual({ kind: "focus", to: "conversation", mode: "normal" })
    expect(decide(base, arrow("down", true))).toEqual({ kind: "focus", to: "input", mode: "insert" })
  })
})

describe("side pane — bare arrows are peers of hjkl", () => {
  it("context view: ↑/↓ move the cursor, ←/→ fold (like h/l)", () => {
    const base = { focus: "side", mode: "normal", view: "context" } as const
    expect(decide(base, arrow("down"))).toEqual({ kind: "sideCursorMove", op: "down" })
    expect(decide(base, arrow("up"))).toEqual({ kind: "sideCursorMove", op: "up" })
    expect(decide(base, arrow("left"))).toEqual({ kind: "sideToggleNode" })
    expect(decide(base, arrow("right"))).toEqual({ kind: "sideToggleNode" })
  })
  it("stack view: ↑/↓ move the cursor, ←/→ fold (like h/l)", () => {
    const base = { focus: "side", mode: "normal", view: "stack" } as const
    expect(decide(base, arrow("down"))).toEqual({ kind: "stackCursorMove", op: "down" })
    expect(decide(base, arrow("up"))).toEqual({ kind: "stackCursorMove", op: "up" })
    expect(decide(base, arrow("left"))).toEqual({ kind: "stackToggle" })
    expect(decide(base, arrow("right"))).toEqual({ kind: "stackToggle" })
  })
})

describe("conversation — Home/End move to line start/end", () => {
  it("NORMAL and VISUAL", () => {
    expect(decide({ focus: "conversation", mode: "normal" }, home)).toEqual({ kind: "cursorMove", op: "lineStart" })
    expect(decide({ focus: "conversation", mode: "normal" }, end)).toEqual({ kind: "cursorMove", op: "lineEnd" })
    expect(decide({ focus: "conversation", mode: "visual" }, home)).toEqual({ kind: "cursorMove", op: "lineStart" })
    expect(decide({ focus: "conversation", mode: "visual" }, end)).toEqual({ kind: "cursorMove", op: "lineEnd" })
  })
})

describe("side pane — context view: select + build", () => {
  const sideCtx = { focus: "side", mode: "normal", view: "context" } as const
  it("Space toggles selection of the turn under the cursor", () => {
    expect(decide(sideCtx, ch(" "))).toEqual({ kind: "sideToggleSelect" })
  })
  it("b builds a new session from the selection", () => {
    expect(decide(sideCtx, ch("b"))).toEqual({ kind: "buildSession" })
  })
  it("still routes the core tree nav", () => {
    expect(decide(sideCtx, ch("j"))).toEqual({ kind: "sideCursorMove", op: "down" })
    expect(decide(sideCtx, tab)).toEqual({ kind: "sideToggleNode" })
    expect(decide(sideCtx, enter)).toEqual({ kind: "sideSelect" })
  })
  it("Space / b do nothing in the side stack view", () => {
    expect(decide({ focus: "side", mode: "normal", view: "stack" }, ch(" "))).toEqual({ kind: "none" })
    expect(decide({ focus: "side", mode: "normal", view: "stack" }, ch("b"))).toEqual({ kind: "none" })
  })
  it("b keeps its conversation meaning (word-back), not build", () => {
    expect(decide({ focus: "conversation", mode: "normal" }, ch("b"))).toEqual({
      kind: "cursorMove",
      op: "wordBack",
    })
  })
})
