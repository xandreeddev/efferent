import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { computePalette, PALETTE_COMMANDS, resolveCommand } from "./palette.js"

describe("the : palette", () => {
  test("a bare ':' shows every command", () => {
    expect(computePalette(":")).toHaveLength(PALETTE_COMMANDS.length)
  })

  test("a prefix narrows; a full command shows its usage row", () => {
    expect(computePalette(":lo").map((c) => c.name)).toEqual(["lock", "login", "logout"])
    expect(computePalette(":model ").map((c) => c.name)).toEqual(["model"])
    expect(computePalette(":forge my-slug").map((c) => c.name)).toEqual(["forge"])
  })

  test("plain text shows nothing", () => {
    expect(computePalette("build a parser")).toEqual([])
    expect(computePalette("")).toEqual([])
  })

  test("resolveCommand: exact and unique-prefix hit, ambiguous misses", () => {
    expect(Option.getOrThrow(resolveCommand("model"))).toBe("model")
    expect(Option.getOrThrow(resolveCommand("mo"))).toBe("model")
    expect(Option.getOrThrow(resolveCommand("q"))).toBe("quit")
    expect(Option.isNone(resolveCommand("lo"))).toBe(true) // lock/login/logout
    expect(Option.isNone(resolveCommand("zzz"))).toBe(true)
    expect(Option.isNone(resolveCommand(""))).toBe(true)
  })
})
