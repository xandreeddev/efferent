import { describe, expect, it } from "bun:test"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  openSelect,
  renderSelectBox,
  selectedValue,
  type SelectOption,
} from "./selectBox.js"

const opts: ReadonlyArray<SelectOption<string>> = [
  { value: "a", label: "anthropic:claude-sonnet" },
  { value: "b", label: "google:gemini-3.5-flash", active: true },
  { value: "c", label: "openai:gpt-4o" },
]

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

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

  it("renders a bordered box with the title, the highlight marker, and a counter", () => {
    const lines = renderSelectBox(openSelect("Select a model", opts), 40, 80).map(
      (o) => stripAnsi(o.content),
    )
    const blob = lines.join("\n")
    expect(blob).toContain("Select a model")
    expect(blob).toContain("▸")
    expect(blob).toContain("◀ active")
    expect(blob).toContain("2/3")
  })

  it("renders a '(no matches)' row when the filter excludes everything", () => {
    const s = filterAppend(openSelect("m", opts), "zzz")
    const blob = renderSelectBox(s, 40, 80)
      .map((o) => stripAnsi(o.content))
      .join("\n")
    expect(blob).toContain("(no matches)")
  })
})
