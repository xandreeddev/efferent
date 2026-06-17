import { describe, expect, it } from "bun:test"
import {
  clearFilter,
  currentRow,
  filterAppend,
  filterBackspace,
  moveSettings,
  openSettings,
  type SettingsRow,
  visibleRows,
} from "./settingsView.js"

const rows: ReadonlyArray<SettingsRow> = [
  { key: "allowBash", label: "allowBash", value: "false", kind: "boolean" },
  { key: "maxSteps", label: "maxSteps", value: "20", kind: "number" },
  { key: "autoApprove", label: "autoApprove", value: "true", kind: "boolean" },
  { key: "telemetry", label: "telemetry", value: "false", kind: "boolean" },
]

describe("settingsView filtering", () => {
  it("no filter shows all rows", () => {
    const s = openSettings(rows)
    expect(visibleRows(s).length).toBe(4)
    expect(s.filter).toBe("")
  })

  it("filter narrows by label/key (case-insensitive)", () => {
    let s = openSettings(rows)
    s = filterAppend(s, "a")
    s = filterAppend(s, "u") // "au" → allowBash? no. autoApprove has "au". maxSteps no.
    expect(visibleRows(s).map((r) => r.key)).toEqual(["autoApprove"])
    expect(currentRow(s)?.key).toBe("autoApprove")
  })

  it("cursor clamps into the filtered view and current row tracks it", () => {
    let s = openSettings(rows)
    s = moveSettings(s, "down")
    s = moveSettings(s, "down") // cursor=2 (autoApprove)
    expect(currentRow(s)?.key).toBe("autoApprove")
    s = filterAppend(s, "t") // "t" matches maxSteps, autoApprove, telemetry → cursor clamps to ≤2
    expect(visibleRows(s).length).toBe(3)
    expect(s.cursor).toBeLessThan(3)
    expect(currentRow(s)).toBeDefined()
  })

  it("backspace widens; clearFilter resets", () => {
    let s = openSettings(rows)
    s = filterAppend(s, "z") // no matches
    expect(visibleRows(s).length).toBe(0)
    expect(currentRow(s)).toBeUndefined()
    s = filterBackspace(s)
    expect(visibleRows(s).length).toBe(4)
    s = filterAppend(s, "tele")
    expect(visibleRows(s).length).toBe(1)
    s = clearFilter(s)
    expect(s.filter).toBe("")
    expect(visibleRows(s).length).toBe(4)
  })

  it("filter is frozen while editing a number row", () => {
    const editing = { ...openSettings(rows), editBuffer: "30" }
    expect(filterAppend(editing, "x").filter).toBe("")
  })
})
