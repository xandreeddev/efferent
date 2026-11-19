import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { parseUnifiedDiff, renderDiff } from "./diff.entity.functions.js"
import type { FileDiff } from "./diff.entity.js"

const DIFF = [
  "diff --git a/src/sum.ts b/src/sum.ts",
  "index 1111111..2222222 100644",
  "--- a/src/sum.ts",
  "+++ b/src/sum.ts",
  "@@ -8,6 +8,7 @@ export const sum = (values: ReadonlyArray<number>) => {",
  "   let total = 0",
  "   for (const value of values) {",
  "-    total += value",
  "+    total += value * 1",
  "+    // counted",
  "   }",
  "",
  "   return total",
  "diff --git a/docs/new file.md b/docs/new file.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new file.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+text",
  "\\ No newline at end of file",
  "diff --git a/old.sql b/old.sql",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old.sql",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "--- a comment that starts like a header",
  "-select 1;",
  "diff --git a/lib/a.ts b/lib/b.ts",
  "similarity index 90%",
  "rename from lib/a.ts",
  "rename to lib/b.ts",
  "index 5555555..6666666 100644",
  "--- a/lib/a.ts",
  "+++ b/lib/b.ts",
  "@@ -3 +3 @@",
  "-old",
  "+new",
  "diff --git a/logo.png b/logo.png",
  "index 7777777..8888888 100644",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git \"a/q\\\"uote.ts\" \"b/q\\\"uote.ts\"",
  "--- \"a/q\\\"uote.ts\"",
  "+++ \"b/q\\\"uote.ts\"",
  "@@ -1 +1,2 @@",
  " a",
  "+b",
  "",
].join("\n")

const parsed = (text: string): ReadonlyArray<FileDiff> => Result.getOrThrow(parseUnifiedDiff(text))

describe("parseUnifiedDiff", () => {
  test("reads each file, how it changed, its counts and its new-side line numbers", () => {
    const files = parsed(DIFF)
    expect(files.map((file) => [file.path, Option.getOrNull(file.oldPath), file.change, file.binary, file.additions, file.deletions, file.hunks.length])).toEqual([
      ["src/sum.ts", null, "modified", false, 2, 1, 1],
      ["docs/new file.md", null, "added", false, 2, 0, 1],
      ["old.sql", null, "deleted", false, 0, 2, 1],
      ["lib/b.ts", "lib/a.ts", "renamed", false, 1, 1, 1],
      ["logo.png", null, "modified", true, 0, 0, 0],
      ["q\"uote.ts", null, "modified", false, 1, 0, 1],
    ])
    expect(files[0]?.hunks[0]).toEqual({
      oldStart: 8, oldCount: 6, newStart: 8, newCount: 7, section: "export const sum = (values: ReadonlyArray<number>) => {",
      lines: [
        { _tag: "Context", line: 8, text: "  let total = 0" },
        { _tag: "Context", line: 9, text: "  for (const value of values) {" },
        { _tag: "Removed", text: "    total += value" },
        { _tag: "Added", line: 10, text: "    total += value * 1" },
        { _tag: "Added", line: 11, text: "    // counted" },
        { _tag: "Context", line: 12, text: "  }" },
        { _tag: "Context", line: 13, text: "" },
        { _tag: "Context", line: 14, text: "  return total" },
      ],
    })
  })

  test("a removed line that starts with -- is read by the hunk's counts, not as a header", () => {
    expect(parsed(DIFF)[2]?.hunks[0]?.lines).toEqual([{ _tag: "Removed", text: "-- a comment that starts like a header" }, { _tag: "Removed", text: "select 1;" }])
  })

  test("omitted counts are 1, and git's no-newline line is kept after the line it follows", () => {
    expect(parsed(DIFF)[3]?.hunks[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1, section: "" })
    expect(parsed(DIFF)[1]?.hunks[0]?.lines.at(-1)).toEqual({ _tag: "NoNewline" })
  })

  test("text before the first file is passed over, and an empty diff has no files", () => {
    expect(parsed("")).toEqual([])
    expect(parsed(`warning: something\n${DIFF}`).length).toBe(6)
  })

  test("a hunk its lines do not fill, or a header that does not read, is DiffUnreadable with its line", () => {
    const short = parseUnifiedDiff(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a"].join("\n"))
    expect(Result.isFailure(short) && short.failure._tag === "DiffUnreadable" && short.failure.line).toBe(4)
    const header = parseUnifiedDiff(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ nonsense @@"].join("\n"))
    expect(Result.isFailure(header) && header.failure.line).toBe(4)
    const extra = parseUnifiedDiff(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "+a", "+b"].join("\n"))
    expect(Result.isFailure(extra) && extra.failure.line).toBe(6)
  })
})

describe("renderDiff", () => {
  test("renders the model-facing diff in fixed words: a header per file, hunks under their function, new-side numbers", () => {
    expect(renderDiff(parsed(DIFF))).toBe([
      "File: src/sum.ts (modified, +2 -1)",
      "@@ export const sum = (values: ReadonlyArray<number>) => {",
      " 8     let total = 0",
      " 9     for (const value of values) {",
      "   -     total += value",
      "10 +     total += value * 1",
      "11 +     // counted",
      "12     }",
      "13   ",
      "14     return total",
      "",
      "File: docs/new file.md (added, +2 -0)",
      "@@",
      "1 + # Title",
      "2 + text",
      "",
      "File: old.sql (deleted, +0 -2)",
      "@@",
      "  - -- a comment that starts like a header",
      "  - select 1;",
      "",
      "File: lib/b.ts (renamed from lib/a.ts, +1 -1)",
      "@@",
      "  - old",
      "3 + new",
      "",
      "File: logo.png (modified, +0 -0, binary, not shown)",
      "",
      "File: q\"uote.ts (modified, +1 -0)",
      "@@",
      "1   a",
      "2 + b",
    ].join("\n"))
  })
})
