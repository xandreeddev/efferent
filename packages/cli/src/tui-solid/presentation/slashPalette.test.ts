import { describe, expect, test } from "bun:test"
import { computePalette, SLASH_COMMANDS } from "./slashPalette.js"

describe("computePalette", () => {
  test("a bare ':' matches every command", () => {
    expect(computePalette(":").matches.length).toBe(SLASH_COMMANDS.length)
  })

  test("filters by command prefix", () => {
    const state = computePalette(":handoff")
    expect(state.matches).toHaveLength(1)
    expect(state.matches[0]!.name).toBe(":handoff")
  })

  test("a non-':' input hides the palette", () => {
    expect(computePalette("hello").visible).toBe(false)
    expect(computePalette(":model now").visible).toBe(false) // a space ends command mode
  })
})
