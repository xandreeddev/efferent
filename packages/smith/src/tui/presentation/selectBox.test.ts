import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  openSelect,
  selectedValue,
} from "./selectBox.js"

const options = [
  { value: "a", label: "alpha" },
  { value: "b", label: "beta", active: true },
  { value: "c", label: "gamma" },
  { value: "d", label: "✓ Done", action: true },
]

describe("selectBox — the pure picker machine", () => {
  test("opens on the active row", () => {
    const sel = openSelect("t", options)
    expect(Option.getOrThrow(selectedValue(sel))).toBe("b")
  })

  test("movement wraps both ways", () => {
    const sel = openSelect("t", options)
    expect(Option.getOrThrow(selectedValue(moveSelect(sel, "down")))).toBe("c")
    const wrapped = [0, 1, 2].reduce((s) => moveSelect(s, "down"), sel)
    expect(Option.getOrThrow(selectedValue(wrapped))).toBe("a")
    expect(Option.getOrThrow(selectedValue(moveSelect(openSelect("t", options), "up")))).toBe("a")
  })

  test("the filter narrows items and HIDES action rows; backspace restores", () => {
    const filtered = ["a", "l"].reduce((s, ch) => filterAppend(s, ch), openSelect("t", options))
    expect(filtered.matches.map((o) => o.value)).toEqual(["a"])
    const restored = ["x", "x"].reduce((s) => filterBackspace(s), filtered)
    expect(restored.matches).toHaveLength(4)
  })

  test("no matches → selectedValue is None", () => {
    const sel = filterAppend(openSelect("t", options), "z")
    expect(Option.isNone(selectedValue(sel))).toBe(true)
  })
})
