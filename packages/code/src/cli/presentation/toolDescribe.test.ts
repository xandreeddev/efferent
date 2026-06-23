import { describe, expect, test } from "bun:test"
import { describeToolCall, describeToolResult, toolArtifacts } from "./toolDescribe.js"
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

describe("fleet comms render as readable, live events (messages flying)", () => {
  test("send_message labels with the content and reports delivery", () => {
    expect(describeToolCall("send_message", { to: "nodeX", content: "re-read the schema" })).toBe(
      "Message(re-read the schema)",
    )
    expect(describeToolResult("send_message", true, { delivered: true })).toBe("delivered")
    expect(describeToolResult("send_message", true, { delivered: false })).toBe("not running")
  })

  test("blackboard post/read label distinctly", () => {
    expect(describeToolCall("blackboard_post", { note: "I own the SQLite adapter" })).toBe(
      "Note(I own the SQLite adapter)",
    )
    expect(describeToolResult("blackboard_post", true, {})).toBe("posted")
    expect(describeToolCall("blackboard_read", {})).toBe("Board(read)")
    expect(describeToolResult("blackboard_read", true, { notes: [1, 2, 3] })).toBe("3 notes")
  })

  test("run_tool + schedule read as their own verbs", () => {
    expect(describeToolCall("run_tool", { name: "find_todos", args: "{}" })).toBe("Tool(find_todos)")
    expect(describeToolCall("schedule", { cron: "0 9 * * 1", task: "review" })).toBe(
      "Schedule(0 9 * * 1)",
    )
    expect(describeToolResult("schedule", true, {})).toBe("scheduled")
  })
})

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

describe("richer tool summaries (the agy polish)", () => {
  test("search_web: a real summary, not 'done' — Search(query) + N sources + the answer", () => {
    expect(describeToolCall("search_web", { query: "effect.ts layers" })).toBe(
      "Search(effect.ts layers)",
    )
    const result = {
      answer: "Layers compose services; provide once at the edge.",
      sources: [
        { title: "Effect docs", url: "https://effect.website/layers" },
        { title: "blog", url: "https://x.dev/y" },
      ],
    }
    expect(describeToolResult("search_web", true, result)).toBe("2 sources")
    const art = toolArtifacts("search_web", true, result)
    expect(art.output).toContain("Layers compose services")
    expect(art.output).toContain("https://effect.website/layers")
  })

  test("write_file: reads like edit_file — a diffstat summary + the diff below the pill", () => {
    const art = toolArtifacts("write_file", true, { path: "out.ts", bytes: 10, lines: 4, diff: DIFF })
    expect(art.diff).toBe(DIFF)
    expect(art.fileChange).toEqual({ path: "out.ts", added: 2, removed: 1 })
    expect(describeToolResult("write_file", true, { path: "out.ts", diff: DIFF })).toBe("+2/-1")
  })

  test("read_file: the call header carries the path; the summary the line count", () => {
    expect(describeToolCall("read_file", { path: "src/main.ts" })).toBe("Read(src/main.ts)")
    expect(describeToolResult("read_file", true, { path: "src/main.ts", content: "x", totalLines: 42 })).toBe(
      "42 lines",
    )
  })

  test("ls/glob surface a previewable output (expanded beneath the pill)", () => {
    const ls = toolArtifacts("ls", true, {
      entries: [
        { path: "a.ts", type: "file" },
        { path: "sub", type: "directory" },
      ],
    })
    expect(ls.output).toBe("a.ts\nsub/")
    const glob = toolArtifacts("glob", true, { matches: ["x.ts", "y.ts"] })
    expect(glob.output).toBe("x.ts\ny.ts")
  })
})
