import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { completeCommand, computePalette, PALETTE_COMMANDS, resolveCommand } from "./palette.js"

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

  test("completeCommand: unique match fills the command + a trailing space", () => {
    expect(Option.getOrThrow(completeCommand(":mo"))).toBe(":model ")
    expect(Option.getOrThrow(completeCommand(":q"))).toBe(":quit ")
    expect(Option.getOrThrow(completeCommand(":sh"))).toBe(":ship ")
    expect(Option.getOrThrow(completeCommand(":se"))).toBe(":settings ")
    expect(Option.getOrThrow(completeCommand(":re"))).toBe(":resume ")
    // A fully-typed command still gets its trailing space (ready for an arg).
    expect(Option.getOrThrow(completeCommand(":forge"))).toBe(":forge ")
  })

  test("completeCommand: several matches extend to the shared stem, then stop", () => {
    // l → lock/login/logout all share 'lo'.
    expect(Option.getOrThrow(completeCommand(":l"))).toBe(":lo")
    // Already at the branch point — the palette shows the fork, nothing to add.
    expect(Option.isNone(completeCommand(":lo"))).toBe(true)
    expect(Option.isNone(completeCommand(":log"))).toBe(true) // login/logout
    expect(Option.isNone(completeCommand(":s"))).toBe(true) // ship/settings
  })

  test("completeCommand: no-op on non-commands, committed args, and misses", () => {
    expect(Option.isNone(completeCommand("build a parser"))).toBe(true)
    expect(Option.isNone(completeCommand(":"))).toBe(true)
    expect(Option.isNone(completeCommand(":forge my-slug"))).toBe(true) // arg already typed
    expect(Option.isNone(completeCommand(":zzz"))).toBe(true)
  })
})
