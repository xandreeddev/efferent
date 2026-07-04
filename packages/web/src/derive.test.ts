import { describe, expect, test } from "bun:test"
import { deriveWorkspaceItem } from "./derive.js"

describe("deriveWorkspaceItem", () => {
  test("read_file → file card with de-numbered content and startLine", () => {
    const item = deriveWorkspaceItem(
      "read_file",
      "c1",
      { path: "src/a.ts", offset: 10 },
      true,
      { path: "src/a.ts", content: "   10\tconst a = 1\n   11\tconst b = 2", totalLines: 50, truncated: false },
    )
    expect(item).toEqual({
      kind: "file",
      file: { path: "src/a.ts", content: "const a = 1\nconst b = 2", startLine: 10 },
    })
  })

  test("read_file truncated note sets the flag and is stripped from content", () => {
    const item = deriveWorkspaceItem("read_file", "c1", { path: "a" }, true, {
      path: "a",
      content: "    1\tx\n... (truncated; file has 900 lines total)",
      totalLines: 900,
      truncated: true,
    })
    expect(item?.kind).toBe("file")
    if (item?.kind === "file") {
      expect(item.file.content).toBe("x")
      expect(item.file.truncated).toBe(true)
    }
  })

  test("edit_file → diff card with counted diffstat, keyed by call id", () => {
    const diff = "--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n+more"
    const item = deriveWorkspaceItem("edit_file", "call-7", { path: "a.ts" }, true, { path: "a.ts", diff })
    expect(item).toEqual({ kind: "diff", diff: { id: "call-7", path: "a.ts", diff, added: 2, removed: 1 } })
  })

  test("update_plan → plan with normalized statuses", () => {
    const item = deriveWorkspaceItem("update_plan", "c", {
      steps: [
        { step: "one", status: "done" },
        { step: "two", status: "active" },
        { step: "three", status: "pending" },
      ],
    }, true, { total: 3, done: 1 })
    expect(item).toEqual({
      kind: "plan",
      plan: { steps: [
        { text: "one", status: "done" },
        { text: "two", status: "active" },
        { text: "three", status: "todo" },
      ] },
    })
  })

  test("search_web → source card with clipped answer + sources", () => {
    const item = deriveWorkspaceItem("search_web", "c9", { query: "bun ws" }, true, {
      answer: "a".repeat(700),
      sources: [{ url: "https://bun.sh", title: "Bun" }, { notAUrl: true }],
    })
    expect(item?.kind).toBe("source")
    if (item?.kind === "source") {
      expect(item.source.query).toBe("bun ws")
      expect(item.source.answer?.length).toBe(601) // 600 + ellipsis
      expect(item.source.sources).toEqual([{ url: "https://bun.sh", title: "Bun" }])
    }
  })

  test("failed calls and unknown tools derive nothing", () => {
    expect(deriveWorkspaceItem("read_file", "c", { path: "a" }, false, { error: "FileNotFound" })).toBeUndefined()
    expect(deriveWorkspaceItem("Bash", "c", { command: "ls" }, true, { stdout: "x" })).toBeUndefined()
    expect(deriveWorkspaceItem("read_file", "c", {}, true, { content: 42 })).toBeUndefined()
  })
})
