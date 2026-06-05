import { describe, expect, test } from "bun:test"
import { clampCursor, foldAt, rowToEnd, rowToTop, stepHead, stepRow, type NavRow } from "./paneNav.js"

// rows: 0 head · 1 child · 2 child · 3 head · 4 child · 5 head(foldable)
const rows: ReadonlyArray<NavRow> = [
  { key: "a", head: true },
  { key: "a1" },
  { key: "a2" },
  { key: "b", head: true, foldId: "fold:b" },
  { key: "b1" },
  { key: "c", head: true, foldId: "fold:c" },
]

describe("clampCursor", () => {
  test("clamps into range and collapses empty to 0", () => {
    expect(clampCursor(6, 9)).toBe(5)
    expect(clampCursor(6, -3)).toBe(0)
    expect(clampCursor(0, 4)).toBe(0)
  })
})

describe("stepRow — paragraph step", () => {
  test("moves by delta, clamped at both ends", () => {
    expect(stepRow(rows, 0, 1)).toBe(1)
    expect(stepRow(rows, 5, 1)).toBe(5) // clamp at end
    expect(stepRow(rows, 0, -1)).toBe(0) // clamp at top
    expect(stepRow(rows, 2, -2)).toBe(0)
  })
})

describe("stepHead — message step", () => {
  test("jumps to the next/prev head, else stays", () => {
    expect(stepHead(rows, 0, 1)).toBe(3) // a → b
    expect(stepHead(rows, 1, 1)).toBe(3) // mid-unit → next head
    expect(stepHead(rows, 3, 1)).toBe(5) // b → c
    expect(stepHead(rows, 5, 1)).toBe(5) // no further head → stay
    expect(stepHead(rows, 4, -1)).toBe(3) // back to b
    expect(stepHead(rows, 2, -1)).toBe(0) // back to a
    expect(stepHead(rows, 0, -1)).toBe(0) // no prior head → stay
  })
  test("empty list → 0", () => {
    expect(stepHead([], 0, 1)).toBe(0)
  })
})

describe("rowToTop / rowToEnd", () => {
  test("first and last indices", () => {
    expect(rowToTop()).toBe(0)
    expect(rowToEnd(rows)).toBe(5)
    expect(rowToEnd([])).toBe(0)
  })
})

describe("foldAt", () => {
  test("toggles the row's foldId on, then off", () => {
    const on = foldAt(rows, 3, new Set())
    expect([...on]).toEqual(["fold:b"])
    const off = foldAt(rows, 3, on)
    expect([...off]).toEqual([])
  })
  test("no-op on a row without a foldId (returns the same set)", () => {
    const before = new Set(["x"])
    expect(foldAt(rows, 1, before)).toBe(before)
  })
})
