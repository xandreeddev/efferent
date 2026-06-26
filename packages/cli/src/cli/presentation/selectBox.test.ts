import { describe, expect, it } from "bun:test"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  openSelect,
  selectedValue,
  type SelectOption,
} from "./selectBox.js"

const opts: ReadonlyArray<SelectOption<string>> = [
  { value: "a", label: "anthropic:claude-sonnet" },
  { value: "b", label: "google:gemini-3.5-flash", active: true },
  { value: "c", label: "openai:gpt-4o" },
]

describe("selectBox", () => {
  it("openSelect preselects the active option", () => {
    const s = openSelect("Select a model", opts)
    expect(s.selected).toBe(1)
    expect(selectedValue(s)).toBe("b")
  })

  it("moveSelect wraps both ways", () => {
    let s = openSelect("m", opts) // selected=1
    s = moveSelect(s, "down")
    expect(selectedValue(s)).toBe("c")
    s = moveSelect(s, "down")
    expect(selectedValue(s)).toBe("a") // wrapped to top
    s = moveSelect(s, "up")
    expect(selectedValue(s)).toBe("c") // wrapped to bottom
  })

  it("filter narrows the matches and clamps the selection", () => {
    let s = openSelect("m", opts)
    s = filterAppend(s, "g") // matches google + (claude has no g? "anthropic:claude-sonnet" has no 'g')
    s = filterAppend(s, "p") // "gpt"/"gemini"? "gp" matches only openai:gpt-4o
    expect(s.matches.map((m) => m.value)).toEqual(["c"])
    expect(selectedValue(s)).toBe("c")
  })

  it("filterBackspace widens again", () => {
    let s = openSelect("m", opts)
    s = filterAppend(s, "z") // no matches
    expect(s.matches.length).toBe(0)
    expect(selectedValue(s)).toBeUndefined()
    s = filterBackspace(s)
    expect(s.matches.length).toBe(3)
  })
})
