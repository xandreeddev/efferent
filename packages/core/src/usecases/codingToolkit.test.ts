import { describe, expect, it } from "bun:test"
import { normalizeEdits, unifiedDiff } from "./codingToolkit.js"

describe("normalizeEdits", () => {
  it("passes the canonical edits array through unchanged", () => {
    const edits = [
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
    ]
    expect(normalizeEdits({ edits })).toEqual(edits)
  })

  it("wraps the flat single-edit form into one edit", () => {
    // The shape models trained on Claude Code's Edit tool emit for one edit.
    expect(normalizeEdits({ oldText: "foo", newText: "bar" })).toEqual([
      { oldText: "foo", newText: "bar" },
    ])
  })

  it("treats a flat oldText with no newText as a deletion", () => {
    expect(normalizeEdits({ oldText: "foo" })).toEqual([{ oldText: "foo", newText: "" }])
  })

  it("prefers a non-empty edits array over the flat fields", () => {
    expect(
      normalizeEdits({
        edits: [{ oldText: "a", newText: "b" }],
        oldText: "ignored",
        newText: "ignored",
      }),
    ).toEqual([{ oldText: "a", newText: "b" }])
  })

  it("falls back to the flat form when edits is an empty array", () => {
    expect(normalizeEdits({ edits: [], oldText: "foo", newText: "bar" })).toEqual([
      { oldText: "foo", newText: "bar" },
    ])
  })

  it("returns no edits when neither shape is present", () => {
    expect(normalizeEdits({})).toEqual([])
    expect(normalizeEdits({ edits: [] })).toEqual([])
  })
})

describe("unifiedDiff", () => {
  it("is empty when nothing changed", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "f.ts")).toBe("")
  })

  it("emits a unified diff with file headers for a single-line change", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.ts")
    expect(diff).toContain("--- f.ts")
    expect(diff).toContain("+++ f.ts")
    expect(diff).toContain("-b")
    expect(diff).toContain("+B")
  })
})
