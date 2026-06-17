import { describe, expect, it } from "bun:test"
import {
  cycleHelpTab,
  helpRows,
  HELP_VISIBLE,
  KEYBINDINGS,
  openHelp,
  scrollHelp,
} from "./helpView.js"
import { SLASH_COMMANDS } from "./slashPalette.js"

describe("helpView", () => {
  it("opens on the commands tab at the top", () => {
    const s = openHelp()
    expect(s.tab).toBe("commands")
    expect(s.scroll).toBe(0)
  })

  it("commands tab derives one entry per slash command", () => {
    const rows = helpRows("commands")
    expect(rows.length).toBe(SLASH_COMMANDS.length)
    expect(rows.every((r) => r.kind === "entry")).toBe(true)
  })

  it("shortcuts tab has a head per group + an entry per binding", () => {
    const rows = helpRows("shortcuts")
    const heads = rows.filter((r) => r.kind === "head").length
    const entries = rows.filter((r) => r.kind === "entry").length
    expect(heads).toBe(KEYBINDINGS.length)
    expect(entries).toBe(KEYBINDINGS.reduce((n, g) => n + g.entries.length, 0))
  })

  it("cycles tabs both ways, resetting scroll", () => {
    let s = scrollHelp(openHelp(), "down")
    expect(s.scroll).toBe(1)
    s = cycleHelpTab(s, "right")
    expect(s.tab).toBe("shortcuts")
    expect(s.scroll).toBe(0)
    s = cycleHelpTab(s, "right")
    expect(s.tab).toBe("commands")
    s = cycleHelpTab(s, "left")
    expect(s.tab).toBe("shortcuts")
  })

  it("scroll clamps to [0, total - HELP_VISIBLE]", () => {
    let s = openHelp()
    expect(scrollHelp(s, "up").scroll).toBe(0) // can't go below 0
    const total = helpRows("commands").length
    const max = Math.max(0, total - HELP_VISIBLE)
    for (let i = 0; i < total + 5; i++) s = scrollHelp(s, "down")
    expect(s.scroll).toBe(max)
  })
})
