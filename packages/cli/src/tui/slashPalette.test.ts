import { describe, expect, test } from "bun:test"
import {
  computePalette,
  renderPalette,
  SLASH_COMMANDS,
  type PaletteState,
} from "./slashPalette.js"

// Strip ANSI (incl. the leading ESC byte) so assertions read plain text.
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
// Each rendered row is "<marker> <:command> <description>"; the command token
// is the first thing starting with ":".
const names = (rows: ReadonlyArray<string>) =>
  rows
    .map((r) => plain(r).trim().split(/\s+/).find((t) => t.startsWith(":")))
    .filter((s): s is string => s !== undefined)

const MAX = 6

describe("renderPalette windowing", () => {
  test("a bare ':' matches every command", () => {
    expect(computePalette(":").matches.length).toBe(SLASH_COMMANDS.length)
    expect(SLASH_COMMANDS.length).toBeGreaterThan(MAX) // otherwise this fix is moot
  })

  test("returns at most maxRows lines", () => {
    expect(renderPalette(computePalette(":"), 80, MAX)).toHaveLength(MAX)
  })

  test("the selected command is always visible in the window", () => {
    const base = computePalette(":")
    for (let sel = 0; sel < base.matches.length; sel++) {
      const state: PaletteState = { ...base, selected: sel }
      expect(names(renderPalette(state, 80, MAX))).toContain(base.matches[sel]!.name)
    }
  })

  test("window scrolls: selecting the last item reveals tail commands hidden at rest", () => {
    const base = computePalette(":")
    const last = base.matches.length - 1
    const atRest = names(renderPalette({ ...base, selected: 0 }, 80, MAX))
    const atEnd = names(renderPalette({ ...base, selected: last }, 80, MAX))
    expect(atRest).not.toContain(base.matches[last]!.name)
    expect(atEnd).toContain(base.matches[last]!.name)
  })

  test("no scroll glyphs when matches fit in the window", () => {
    const state = computePalette(":handoff")
    expect(state.matches).toHaveLength(1)
    const rows = renderPalette(state, 80, MAX)
    expect(rows).toHaveLength(1)
    expect(plain(rows[0]!)).not.toContain("↑")
    expect(plain(rows[0]!)).not.toContain("↓")
  })
})
