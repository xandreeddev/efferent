import { describe, expect, test } from "bun:test"
import { Scrollback, type ScrollbackBlock } from "./scrollback.js"

// eslint-disable-next-line no-control-regex
const plain = (lines: string[]) =>
  lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
const has = (lines: string[], sub: string) => plain(lines).some((l) => l.includes(sub))

const tool = (id: string, name: string): ScrollbackBlock => ({
  kind: "tool",
  id,
  toolName: name,
  state: "ok",
})

const turnWithTools = (): Scrollback => {
  const sb = new Scrollback()
  sb.push({ kind: "user", text: "do the thing" })
  sb.push({ kind: "assistant", text: "on it" })
  sb.push(tool("1", "read a"))
  sb.push(tool("2", "edit b"))
  sb.push(tool("3", "bash c"))
  return sb
}

describe("Neogit folding", () => {
  test("expanded turn: header + assistant + a tool group with visible pills", () => {
    const out = turnWithTools().render(40, 70)
    expect(has(out, "▾")).toBe(true)
    expect(has(out, "do the thing")).toBe(true) // turn header subject
    expect(has(out, "3 tool calls")).toBe(true) // group header
    expect(has(out, "read a")).toBe(true) // pills visible
    expect(has(out, "on it")).toBe(true)
  })

  test("fold-all collapses each turn to one header; the body is hidden", () => {
    const sb = turnWithTools()
    sb.render(40, 70) // populate foldableIds
    sb.setAllFolded(true)
    const out = sb.render(40, 70)
    expect(has(out, "▸")).toBe(true)
    expect(has(out, "do the thing")).toBe(true)
    expect(has(out, "read a")).toBe(false) // body hidden
    expect(has(out, "on it")).toBe(false)
  })

  test("a tool group stays folded as a new pill streams in (stable group id)", () => {
    const sb = turnWithTools()
    let out = plain(sb.render(40, 70))
    const gi = out.findIndex((l) => l.includes("tool calls"))
    expect(gi).toBeGreaterThan(0)
    // Put the cursor on the group header line and fold just that group.
    sb.cursorToTop()
    sb.moveCursor(gi)
    sb.foldToggleAtCursor()
    out = plain(sb.render(40, 70))
    expect(out.some((l) => l.includes("3 tool calls") && l.includes("⊞"))).toBe(true)
    expect(out.some((l) => l.includes("read a"))).toBe(false) // folded
    // A 4th tool streams into the same turn — the group id is keyed on the
    // first member, so it must STAY folded and just bump the count.
    sb.push(tool("4", "grep d"))
    out = plain(sb.render(40, 70))
    expect(out.some((l) => l.includes("4 tool calls"))).toBe(true)
    expect(out.some((l) => l.includes("read a"))).toBe(false)
    expect(out.some((l) => l.includes("on it"))).toBe(true) // turn still expanded
  })
})
