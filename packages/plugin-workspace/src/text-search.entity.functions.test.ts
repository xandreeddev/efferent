import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import fc from "fast-check"
import { compilePattern, renderSearchLines, repeatsRepetition, searchText } from "./text-search.entity.functions.js"

const regex = (pattern: string, options: { readonly literal?: boolean; readonly ignoreCase?: boolean } = {}) =>
  Result.getOrThrow(compilePattern(pattern, { literal: options.literal ?? false, ignoreCase: options.ignoreCase ?? false }))
const wide = { lineChars: 500, context: 0, cap: 100 }

describe("compilePattern", () => {
  test("regular expressions, literal text and case", () => {
    expect(regex("a.c").test("abc")).toBe(true)
    expect(regex("a.c", { literal: true }).test("abc")).toBe(false)
    expect(regex("a.c", { literal: true }).test("xa.cx")).toBe(true)
    expect(regex("f(x)[0]", { literal: true }).test("call f(x)[0]")).toBe(true)
    expect(regex("TODO", { ignoreCase: true }).test("// todo: later")).toBe(true)
    expect(Result.isFailure(compilePattern("a(", { literal: false, ignoreCase: false }))).toBe(true)
  })

  test("a pattern that repeats a repeating group is refused, since it can backtrack exponentially", () => {
    const nested = ["(a+)+$", "(x*)*", "(?:\\w+\\s?)*$", "((ab)+)+", "(a+){2,}", "(.*a)+", "(?<word>\\w+)*", "(a+|b)+"]
    const fine = ["(\\d+\\.){3}\\d+", "a+b+", "(foo|bar)+", "\\(a+\\)+", "[(a+)]+", "(a)+(b+)", "(a+)?", "x{2,}", "(?:ab)*c", "[^)]*\\)+"]
    expect(nested.filter((pattern) => !repeatsRepetition(pattern))).toEqual([])
    expect(fine.filter(repeatsRepetition)).toEqual([])
    const refused = compilePattern("(a+)+$", { literal: false, ignoreCase: false })
    expect(Result.isFailure(refused) ? refused.failure : undefined).toMatchObject({ error: "InvalidPattern" })
    expect(Result.isFailure(refused) ? refused.failure.message : "").toContain("exponential")
    expect(Result.isSuccess(compilePattern("(a+)+$", { literal: true, ignoreCase: false }))).toBe(true)
    const invalid = compilePattern("a(", { literal: false, ignoreCase: false })
    expect(Result.isFailure(invalid) ? invalid.failure.message : "").toContain("pass literal: true")
  })
})

describe("searchText", () => {
  const text = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].join("\n")

  test("matching lines with their numbers", () => {
    expect(searchText(text, regex("ta$"), wide)).toEqual({
      lines: [{ line: 2, text: "beta", match: true }, { line: 4, text: "delta", match: true }, { line: 6, text: "zeta", match: true }, { line: 7, text: "eta", match: true }],
      matches: 4, capped: false,
    })
  })

  test("context lines around matches, merged when they overlap", () => {
    const found = searchText(text, regex("^(beta|delta)$"), { ...wide, context: 1 })
    expect(found.lines.map((line) => `${line.line}${line.match ? "*" : ""}`)).toEqual(["1", "2*", "3", "4*", "5"])
    expect(renderSearchLines(found.lines.map((line) => ({ path: "f", ...line })), true)).toEqual(["f-1-alpha", "f:2:beta", "f-3-gamma", "f:4:delta", "f-5-epsilon"])
    const apart = searchText(text, regex("^(alpha|eta)$"), { ...wide, context: 1 })
    expect(renderSearchLines(apart.lines.map((line) => ({ path: "f", ...line })), true)).toEqual(["f:1:alpha", "f-2-beta", "--", "f-6-zeta", "f:7:eta"])
    expect(renderSearchLines([{ path: "f", line: 1, text: "a", match: true }, { path: "f", line: 5, text: "b", match: true }], false)).toEqual(["f:1:a", "f:5:b"])
  })

  test("stops at the cap and says more matched", () => {
    expect(searchText(text, regex("a"), { ...wide, cap: 2 })).toEqual({
      lines: [{ line: 1, text: "alpha", match: true }, { line: 2, text: "beta", match: true }], matches: 2, capped: true,
    })
    expect(searchText(text, regex("^alpha$"), { ...wide, cap: 1 }).capped).toBe(false)
  })

  test("lines are cut before matching: a match past the cut is not found", () => {
    const long = `${"x".repeat(600)}needle`
    expect(searchText(long, regex("needle"), wide).matches).toBe(0)
    expect(searchText(`needle${"x".repeat(600)}`, regex("needle"), wide).lines[0]?.text).toHaveLength(500)
  })

  test("property: every shown line is cut to the width, and every match matches its cut text", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ maxLength: 40 }).map((line) => line.replace(/[\r\n]/g, "")), { maxLength: 30 }),
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 0, max: 3 }),
      fc.constantFrom("a", "b+", "^.", "x$"),
      (lines, lineChars, context, pattern) => {
        const found = searchText(lines.join("\n"), regex(pattern), { lineChars, context, cap: 1_000 })
        expect(found.lines.every((line) => line.text.length <= lineChars)).toBe(true)
        expect(found.lines.filter((line) => line.match).every((line) => regex(pattern).test(line.text))).toBe(true)
        expect(found.lines.map((line) => line.line)).toEqual([...new Set(found.lines.map((line) => line.line))].sort((left, right) => left - right))
      },
    ))
  })
})
