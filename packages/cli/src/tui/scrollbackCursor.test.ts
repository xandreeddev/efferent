import { describe, expect, test } from "bun:test"
import {
  firstNonBlank,
  nextWordStart,
  prevWordStart,
  Scrollback,
  wordEnd,
} from "./scrollback.js"

describe("word-motion helpers (pure)", () => {
  test("nextWordStart — word vs WORD", () => {
    expect(nextWordStart("foo bar baz", 0, false)).toBe(4)
    expect(nextWordStart("foo bar baz", 4, false)).toBe(8)
    expect(nextWordStart("foo.bar", 0, false)).toBe(3) // punctuation starts a word
    expect(nextWordStart("foo.bar baz", 0, true)).toBe(8) // WORD = whitespace-delimited
    expect(nextWordStart("foo", 0, false)).toBe(-1) // none after
  })
  test("prevWordStart", () => {
    expect(prevWordStart("foo bar baz", 8, false)).toBe(4)
    expect(prevWordStart("foo bar", 5, false)).toBe(4)
    expect(prevWordStart("foo", 1, false)).toBe(0)
    expect(prevWordStart("   ", 1, false)).toBe(-1)
  })
  test("wordEnd", () => {
    expect(wordEnd("foo bar", 0, false)).toBe(2) // end of 'foo'
    expect(wordEnd("foo bar", 2, false)).toBe(6) // end of 'bar'
    expect(wordEnd("foo", 2, false)).toBe(-1)
  })
  test("firstNonBlank", () => {
    expect(firstNonBlank("   hi")).toBe(3)
    expect(firstNonBlank("hi")).toBe(0)
    expect(firstNonBlank("   ")).toBe(0) // all blank → 0
  })
})

// `info` blocks render to exactly their text (one line, ANSI-stripped), so the
// flat-line geometry is deterministic: ["abcdef","","xy",""] for two infos.
const seed = (...texts: string[]): Scrollback => {
  const sb = new Scrollback()
  for (const t of texts) sb.push({ kind: "info", text: t })
  sb.render(20, 60)
  return sb
}

describe("2D block cursor", () => {
  test("h/l clamp to the visible line length", () => {
    const sb = seed("abcdef")
    sb.cursorToTop()
    expect(sb.cursorVisibleCol()).toBe(0)
    sb.cursorCharLeft()
    expect(sb.cursorVisibleCol()).toBe(0) // clamped at 0
    for (let i = 0; i < 10; i++) sb.cursorCharRight()
    expect(sb.cursorVisibleCol()).toBe(5) // clamped at last col of "abcdef"
  })

  test("j keeps the desired column over ragged lines", () => {
    const sb = seed("abcdef", "xy") // lines: abcdef / "" / xy
    sb.cursorToTop()
    for (let i = 0; i < 4; i++) sb.cursorCharRight() // col 4
    expect(sb.cursorVisibleCol()).toBe(4)
    sb.moveCursor(1) // onto the blank line → col clamps to 0
    expect(sb.cursorVisibleCol()).toBe(0)
    sb.moveCursor(1) // onto "xy" → desired 4 clamps to last col 1
    expect(sb.cursorVisibleCol()).toBe(1)
  })

  test("$ parks at the end so j sticks to line ends", () => {
    const sb = seed("abcdef", "xy")
    sb.cursorToTop()
    sb.cursorLineEnd()
    expect(sb.cursorVisibleCol()).toBe(5)
    sb.moveCursor(2) // → "xy"
    expect(sb.cursorVisibleCol()).toBe(1) // stuck to the end, not col 5
  })

  test("0 returns to the first column", () => {
    const sb = seed("abcdef")
    sb.cursorToTop()
    sb.cursorLineEnd()
    sb.cursorLineStart()
    expect(sb.cursorVisibleCol()).toBe(0)
  })
})

describe("cursorToMessageIndex (context-view jump)", () => {
  test("jumps to a tagged message; false when the message isn't in the buffer", () => {
    const sb = new Scrollback()
    sb.push({ kind: "user", text: "first", msgIndex: 0 })
    sb.push({ kind: "assistant", text: "answer one", msgIndex: 1 })
    sb.push({ kind: "user", text: "second question", msgIndex: 2 })
    sb.render(40, 60)
    expect(sb.cursorToMessageIndex(0)).toBe(true)
    const l0 = sb.cursorIndex()
    expect(sb.cursorToMessageIndex(2)).toBe(true)
    expect(sb.cursorIndex()).toBeGreaterThan(l0)
    expect(sb.cursorToMessageIndex(99)).toBe(false)
  })
})

describe("VISUAL selection", () => {
  test("charwise yanks the exact span", () => {
    const sb = seed("hello world")
    sb.cursorToTop()
    sb.startVisual("char")
    for (let i = 0; i < 4; i++) sb.cursorCharRight() // cover h-e-l-l-o (cols 0..4)
    expect(sb.selectionText()).toBe("hello")
  })

  test("linewise yanks whole lines", () => {
    const sb = seed("aaaa", "bb") // lines: aaaa / "" / bb
    sb.cursorToTop()
    sb.startVisual("line")
    sb.moveCursor(2) // through the blank to "bb"
    expect(sb.selectionText()).toBe("aaaa\n\nbb")
  })
})
