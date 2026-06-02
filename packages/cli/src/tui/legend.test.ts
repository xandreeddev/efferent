import { describe, expect, it } from "bun:test"
import { KEYBIND_KEY_ROWS, legendContent } from "./legend.js"

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")
const WIDE = 120

describe("legendContent — two labelled rows (nav + pane)", () => {
  it("always returns exactly KEYBIND_KEY_ROWS rows", () => {
    const { rows } = legendContent("conversation", "normal", "stack", "message", WIDE)
    expect(rows.length).toBe(KEYBIND_KEY_ROWS)
  })

  it("the nav row advertises pane switching in every message-mode pane", () => {
    for (const [focus, view] of [
      ["conversation", "stack"],
      ["side", "context"],
      ["side", "stack"],
      ["input", "stack"],
    ] as const) {
      const { rows } = legendContent(focus, focus === "input" ? "insert" : "normal", view, "message", WIDE)
      const nav = stripAnsi(rows[0]!)
      expect(nav).toContain("nav")
      expect(nav).toContain("panes")
    }
  })

  it("conversation NORMAL: title + dynamic pane keys", () => {
    const { title, rows } = legendContent("conversation", "normal", "stack", "message", WIDE)
    expect(title).toBe("conversation · NORMAL")
    const pane = stripAnsi(rows[1]!)
    expect(pane).toContain("pane")
    expect(pane).toContain("fold")
  })

  it("side context view surfaces select + build", () => {
    const { rows } = legendContent("side", "normal", "context", "message", WIDE)
    expect(stripAnsi(rows[1]!)).toContain("build")
  })

  it("command entry takes the top row (cmd) and blanks the bottom", () => {
    const { rows } = legendContent("input", "insert", "stack", "command", WIDE)
    const top = stripAnsi(rows[0]!)
    expect(top).toContain("cmd")
    expect(top).toContain("run")
    expect(stripAnsi(rows[1]!).trim()).toBe("")
  })

  it("search entry shows find + jump", () => {
    const { rows } = legendContent("input", "insert", "stack", "search", WIDE)
    const top = stripAnsi(rows[0]!)
    expect(top).toContain("find")
    expect(top).toContain("jump")
  })
})
