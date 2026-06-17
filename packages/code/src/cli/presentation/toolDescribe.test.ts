import { describe, expect, test } from "bun:test"
import { toolArtifacts } from "./toolDescribe.js"
import { mergeFileChange, type FileChange } from "./sidePane.js"

const DIFF = [
  "--- src/math.ts",
  "+++ src/math.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  "+const c = 4",
].join("\n")

describe("toolArtifacts.fileChange — structured diffstat (no regex on the detail string)", () => {
  test("edit_file: counts +/- from the diff and takes the path from the result", () => {
    const art = toolArtifacts("edit_file", true, { path: "src/math.ts", editsApplied: 1, diff: DIFF })
    expect(art.diff).toBe(DIFF)
    expect(art.fileChange).toEqual({ path: "src/math.ts", added: 2, removed: 1 })
  })

  test("write_file: added = lines, removed = 0", () => {
    const art = toolArtifacts("write_file", true, { path: "out.ts", bytes: 10, lines: 4 })
    expect(art.fileChange).toEqual({ path: "out.ts", added: 4, removed: 0 })
    // write_file shows no inline diff/output pill
    expect(art.diff).toBeUndefined()
    expect(art.output).toBeUndefined()
  })

  test("a failed edit yields no fileChange (just the error output)", () => {
    const art = toolArtifacts("edit_file", false, { _tag: "EditFailed", message: "no match" })
    expect(art.fileChange).toBeUndefined()
    expect(art.output).toContain("EditFailed")
  })

  test("read_file has no fileChange", () => {
    expect(toolArtifacts("read_file", true, { content: "x", totalLines: 1 }).fileChange).toBeUndefined()
  })
})

describe("mergeFileChange — find-or-append accumulation", () => {
  test("appends a new path, sums into an existing one", () => {
    const a: FileChange = { path: "a.ts", added: 2, removed: 1 }
    const b: FileChange = { path: "b.ts", added: 5, removed: 0 }
    const more: FileChange = { path: "a.ts", added: 3, removed: 4 }
    const after = mergeFileChange(mergeFileChange([a], b), more)
    expect(after).toEqual([
      { path: "a.ts", added: 5, removed: 5 },
      { path: "b.ts", added: 5, removed: 0 },
    ])
  })
})
