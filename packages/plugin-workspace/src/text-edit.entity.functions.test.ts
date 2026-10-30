import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import fc from "fast-check"
import { applyTextEdits, lineEndingOf, normalizeLine, unifiedDiff } from "./text-edit.entity.functions.js"

const exact = { fuzzy: false }
const fuzzy = { fuzzy: true }
const errorOf = (result: Result.Result<unknown, { readonly error: string }>) => Result.isFailure(result) ? result.failure.error : "ok"
const textOf = (result: Result.Result<{ readonly text: string }, unknown>) => Result.isSuccess(result) ? result.success.text : undefined

describe("applyTextEdits", () => {
  const file = "const a = 1\nconst b = 2\nconst c = 3\n"

  test("replaces each edit's unique text, all matched against the original", () => {
    const plan = Result.getOrThrow(applyTextEdits(file, [
      { oldText: "const c = 3", newText: "const c = 30" },
      { oldText: "const a = 1", newText: "const a = 10\nconst a2 = 11" },
    ], exact))
    expect(plan).toMatchObject({ text: "const a = 10\nconst a2 = 11\nconst b = 2\nconst c = 30\n", replaced: 2, normalized: false, firstChangedLine: 1 })
    // The second edit's text exists only in the first edit's result: it is not found.
    expect(errorOf(applyTextEdits(file, [{ oldText: "const b = 2", newText: "const x = 9" }, { oldText: "const x = 9", newText: "y" }], exact))).toBe("NoMatch")
  })

  test("refuses empty, missing, repeated, overlapping and no-op edits", () => {
    expect(errorOf(applyTextEdits(file, [{ oldText: "", newText: "x" }], exact))).toBe("EmptyOldText")
    expect(errorOf(applyTextEdits(file, [{ oldText: "const d", newText: "x" }], exact))).toBe("NoMatch")
    expect(errorOf(applyTextEdits(file, [{ oldText: "const", newText: "let" }], exact))).toBe("AmbiguousMatch")
    expect(errorOf(applyTextEdits("aaa", [{ oldText: "aa", newText: "b" }], exact))).toBe("AmbiguousMatch")
    expect(errorOf(applyTextEdits(file, [{ oldText: "a = 1\nconst b", newText: "x" }, { oldText: "const b = 2", newText: "y" }], exact))).toBe("OverlappingEdits")
    expect(errorOf(applyTextEdits(file, [{ oldText: "const b = 2", newText: "const b = 2" }], exact))).toBe("NoChange")
  })

  test("each refusal says what is wrong and what to do, naming the edit when there are several", () => {
    const refusal = (original: string, edits: ReadonlyArray<{ readonly oldText: string; readonly newText: string }>, options = exact) =>
      Result.match(applyTextEdits(original, edits, options), { onFailure: (failure) => failure, onSuccess: () => ({ error: "ok", message: "" }) })
    expect([
      refusal(file, [{ oldText: "", newText: "x" }]),
      refusal(file, [{ oldText: "const a = 1", newText: "x" }, { oldText: "", newText: "x" }]),
      refusal(file, [{ oldText: "const d", newText: "x" }]),
      refusal(file, [{ oldText: "const a = 1", newText: "x" }, { oldText: "const d", newText: "x" }]),
      refusal(file, [{ oldText: "const", newText: "let" }]),
      refusal("aaa", [{ oldText: "aa", newText: "b" }]),
      refusal("x = 1\n\tx = 1\n", [{ oldText: "x  =  1", newText: "y" }], fuzzy),
      refusal(file, [{ oldText: "const c = 3", newText: "z" }, { oldText: "a = 1\nconst b", newText: "x" }, { oldText: "const b = 2", newText: "y" }]),
      refusal(file, [{ oldText: "const b = 2", newText: "const b = 2" }]),
    ]).toEqual([
      { error: "EmptyOldText", message: "oldText is empty; to create a file or replace all of it, use write" },
      { error: "EmptyOldText", message: "edit 2's oldText is empty; to create a file or replace all of it, use write" },
      { error: "NoMatch", message: "oldText was not found in the file; read it again and copy the text exactly, whitespace included" },
      { error: "NoMatch", message: "edit 2's oldText was not found in the file; read it again and copy the text exactly, whitespace included" },
      { error: "AmbiguousMatch", message: "oldText appears 3 times; add surrounding lines so it appears exactly once" },
      { error: "AmbiguousMatch", message: "oldText appears 2 times; add surrounding lines so it appears exactly once" },
      { error: "AmbiguousMatch", message: "oldText matches 2 places once whitespace and quotes are normalised; add surrounding lines so it matches exactly once" },
      { error: "OverlappingEdits", message: "edits 2 and 3 change overlapping text; merge them into one edit" },
      { error: "NoChange", message: "the edits leave the file as it is" },
    ])
  })

  test("adjacent edits are not overlapping", () => {
    expect(textOf(applyTextEdits("abcd", [{ oldText: "ab", newText: "1" }, { oldText: "cd", newText: "2" }], exact))).toBe("12")
  })

  test("keeps CRLF line endings: matches with \\n and writes \\r\\n", () => {
    const crlf = "one\r\ntwo\r\nthree\r\n"
    expect(lineEndingOf(crlf)).toBe("crlf")
    const plan = Result.getOrThrow(applyTextEdits(crlf, [{ oldText: "two\nthree", newText: "2\n3\n3b" }], exact))
    expect(plan.text).toBe("one\r\n2\r\n3\r\n3b\r\n")
    expect(plan.after).toBe("one\n2\n3\n3b\n")
    // Edits written with CRLF match an LF file.
    expect(textOf(applyTextEdits("x\ny\n", [{ oldText: "x\r\ny", newText: "z" }], exact))).toBe("z\n")
    expect(lineEndingOf("a\r\nb\n")).toBe("mixed")
    expect(textOf(applyTextEdits("a\r\nb\n", [{ oldText: "b", newText: "c" }], exact))).toBe("a\r\nc\n")
  })

  test("falls back to a normalised match over whole lines, which must be unique", () => {
    const source = "function f() {\n    return “quoted” – value\n}\n"
    expect(errorOf(applyTextEdits(source, [{ oldText: "return \"quoted\" - value", newText: "x" }], exact))).toBe("NoMatch")
    const plan = Result.getOrThrow(applyTextEdits(source, [{ oldText: "  return  \"quoted\" - value", newText: "    return 1" }], fuzzy))
    expect(plan).toMatchObject({ text: "function f() {\n    return 1\n}\n", normalized: true, firstChangedLine: 2 })
    expect(errorOf(applyTextEdits("x = 1\n\tx = 1\n", [{ oldText: "x  =  1", newText: "y" }], fuzzy))).toBe("AmbiguousMatch")
    expect(normalizeLine("  ‘a’ —\tb  ")).toBe("'a' - b")
  })

  test("a normalised match ends where an exact one would: deleting whole lines leaves no blank line", () => {
    expect(textOf(applyTextEdits("a\n  b   x  \nc\n", [{ oldText: "b x\n", newText: "" }], fuzzy))).toBe("a\nc\n")
    expect(textOf(applyTextEdits("a\nb x\nc\n", [{ oldText: "b x\n", newText: "" }], exact))).toBe("a\nc\n")
    expect(textOf(applyTextEdits("a\n  b   x  \nc\n", [{ oldText: "b x", newText: "" }], fuzzy))).toBe("a\n\nc\n")
    expect(textOf(applyTextEdits("a\n  b   x  \nc\n", [{ oldText: "b x\n", newText: "y\n" }], fuzzy))).toBe("a\ny\nc\n")
    expect(textOf(applyTextEdits("a\n  b  \nc  d", [{ oldText: "c d\n", newText: "" }], fuzzy))).toBe("a\n  b  \n")
    // A mixed file keeps the \r\n of a line whose text is replaced without its break.
    expect(textOf(applyTextEdits("a\r\n  b   x  \r\nc\n", [{ oldText: "b x", newText: "y" }], fuzzy))).toBe("a\r\ny\r\nc\n")
    expect(textOf(applyTextEdits("a\r\n  b   x  \r\nc\n", [{ oldText: "a\nb x\n", newText: "" }], fuzzy))).toBe("c\n")
  })

  test("a unified diff of the change", () => {
    expect(unifiedDiff("f.txt", "a\nb\n", "a\nc\n", 1_000)).toBe("--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n")
    expect(unifiedDiff("f.txt", "a\nb\n", "a\nc\n", 10)).toEndWith("[diff cut at 10 characters]\n")
  })
})

/** A file of distinct lines, so any of its lines is unique text. */
const distinctLines = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 2, maxLength: 12 }).map((words) => words.map((word, at) => `L${at}:${word};`))

describe("applyTextEdits properties", () => {
  test("edits of distinct lines give the same text in any order, and undo with the inverse edits", () => {
    fc.assert(fc.property(distinctLines, fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), (lines, picks) => {
      const original = `${lines.join("\n")}\n`
      const chosen = [...new Set(picks.map((pick) => pick % lines.length))]
      const edits = chosen.map((at) => ({ oldText: lines[at] ?? "", newText: `${lines[at] ?? ""}!` }))
      const forward = Result.getOrThrow(applyTextEdits(original, edits, exact))
      const reversed = Result.getOrThrow(applyTextEdits(original, [...edits].reverse(), exact))
      expect(reversed.text).toBe(forward.text)
      expect(forward.replaced).toBe(edits.length)
      const back = Result.getOrThrow(applyTextEdits(forward.text, edits.map((edit) => ({ oldText: edit.newText, newText: edit.oldText })), exact))
      expect(back.text).toBe(original)
    }))
  })

  test("on lines the normaliser leaves as they are, a normalised match gives what the exact match gives", () => {
    fc.assert(fc.property(
      distinctLines, fc.nat(), fc.nat(), fc.boolean(), fc.constantFrom("", "X", "X\n", "X\nY", "X\nY\n"),
      (lines, from, length, withBreak, newText) => {
        const start = from % lines.length
        const run = lines.slice(start, start + 1 + (length % (lines.length - start)))
        const original = `${lines.join("\n")}\n`
        const exactText = `${run.join("\n")}${withBreak ? "\n" : ""}`
        const spaced = `${run.map((line) => `  ${line}\t `).join("\n")}${withBreak ? "\n" : ""}`
        const byExact = Result.getOrThrow(applyTextEdits(original, [{ oldText: exactText, newText }], exact))
        const byNormal = Result.getOrThrow(applyTextEdits(original, [{ oldText: spaced, newText }], fuzzy))
        expect(byNormal.normalized).toBe(true)
        expect(byNormal.text).toBe(byExact.text)
      },
    ))
  })

  test("a CRLF file gets the CRLF form of what the LF file gets", () => {
    fc.assert(fc.property(distinctLines, fc.nat(), (lines, pick) => {
      const target = lines[pick % lines.length] ?? ""
      const edits = [{ oldText: target, newText: `${target}\nadded` }]
      const lf = Result.getOrThrow(applyTextEdits(`${lines.join("\n")}\n`, edits, exact))
      const crlf = Result.getOrThrow(applyTextEdits(`${lines.join("\r\n")}\r\n`, edits, exact))
      expect(crlf.text).toBe(lf.text.replaceAll("\n", "\r\n"))
    }))
  })
})
