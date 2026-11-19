import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import type { FilePath } from "./files.entity.js"
import { editText, filePageOf, inFolder, notInWorkspace, workspaceFolder, workspacePath } from "./files.entity.functions.js"

const ok = <A>(result: Result.Result<A, string>): A => Result.getOrThrowWith(result, (problem) => new Error(problem))
const refusal = <A>(result: Result.Result<A, string>): string => Result.match(result, { onSuccess: () => "accepted", onFailure: (problem) => problem })

describe("paths in the workspace", () => {
  test("a relative path is kept; empty names and . between slashes are dropped", () => {
    expect<ReadonlyArray<string>>(["notes/todo.md", "./notes//todo.md", "notes/./todo.md/", "a b/c-d_e.txt", "..hidden/x", "notes/..x", "é/😀.md"].map((path) => ok(workspacePath(path))))
      .toEqual(["notes/todo.md", "notes/todo.md", "notes/todo.md", "a b/c-d_e.txt", "..hidden/x", "notes/..x", "é/😀.md"])
  })

  test("a path that leaves the workspace, or holds what no path takes, is refused", () => {
    const refused = ["/etc/passwd", "..", "../a", "a/../../b", "a/..", "", ".", "./", "C:/x", "a\\b", "a\nb", "a\u0085b", "a\u2028b", "x".repeat(161)]
    expect(refused.map((path) => Result.isFailure(workspacePath(path)))).toEqual(refused.map(() => true))
  })

  test("the refusal names the path and says what a path is, in fixed words, a long path cut with what was cut counted", () => {
    expect(notInWorkspace("../a")).toBe("The path \"../a\" is not a path in the workspace. Give a path relative to the workspace, with / between folders and no \"..\", such as notes/todo.md.")
    expect(refusal(workspacePath("x".repeat(161)))).toBe(
      `The path ${JSON.stringify("x".repeat(80))} [… 81 characters clipped] is not a path in the workspace. Give a path relative to the workspace, with / between folders and no "..", such as notes/todo.md.`,
    )
  })

  test("a folder is the whole workspace when none is named; a file is in a folder only under its name and a slash", () => {
    expect([undefined, "", ".", "./"].map((folder) => ok(workspaceFolder(folder)))).toEqual([Option.none(), Option.none(), Option.none(), Option.none()])
    expect(ok(workspaceFolder("notes/"))).toEqual(Option.some("notes" as FilePath))
    expect(Result.isFailure(workspaceFolder("/"))).toBe(true)
    const notes = Option.some("notes" as FilePath)
    expect(["notes/a", "notes/b/c", "notesx", "notes"].map((path) => inFolder(path as FilePath, notes))).toEqual([true, true, false, false])
  })
})

describe("a page of a file and an edit", () => {
  test("an empty file has one page, from 0; a start past the end is refused", () => {
    const empty = "e.txt" as FilePath
    expect<unknown>(ok(filePageOf(empty, "", 0))).toEqual({ path: "e.txt", text: "", from: 0, to: 0, total: 0 })
    expect(refusal(filePageOf(empty, "abc", 3))).toBe("e.txt is 3 characters long: from must be less than 3.")
  })

  test("an edit replaces the one place that holds the text, taking the replacement as it is", () => {
    const path = "a.txt" as FilePath
    expect(ok(editText(path, "one two three", "two", "$& $1 $$"))).toBe("one $& $1 $$ three")
    expect(ok(editText(path, "aaa", "aaa", ""))).toBe("")
    // Places are counted without overlap: "aa" is in "aaa" once.
    expect(ok(editText(path, "aaa", "aa", "b"))).toBe("ba")
    expect(refusal(editText(path, "aaaa", "aa", "b"))).toBe("The text to find is in a.txt 2 times, so nothing was changed. Give more of the text around the place to change, so that it is there once.")
  })
})
