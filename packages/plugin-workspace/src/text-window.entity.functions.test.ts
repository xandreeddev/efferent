import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import fc from "fast-check"
import { clipChars, clipHead, clipTail, decodeText, encodeText, formatBytes, headLines, lineWindow, looksBinary, mediaTypeOf, splitLines, tailText, utf8Length } from "./text-window.entity.functions.js"

const lines = (count: number, width = 3) => Array.from({ length: count }, (_, at) => `${at + 1}`.padStart(width, "0"))

describe("lineWindow", () => {
  test("shows a window of whole lines and says where to continue", () => {
    const text = `${lines(10).join("\n")}\n`
    expect(lineWindow(text, { offset: 1, limit: 4, maxBytes: 1_000 })).toEqual(Result.succeed({
      lines: ["001", "002", "003", "004"], firstLine: 1, lastLine: 4, totalLines: 10, next: Option.some(5), clipped: false,
    }))
    expect(lineWindow(text, { offset: 9, limit: 4, maxBytes: 1_000 })).toEqual(Result.succeed({
      lines: ["009", "010"], firstLine: 9, lastLine: 10, totalLines: 10, next: Option.none(), clipped: false,
    }))
    // Bytes bind before lines: each line is 4 bytes with its newline.
    expect(Result.map(lineWindow(text, { offset: 2, limit: 100, maxBytes: 9 }), (window) => [window.lines, window.next])).toEqual(Result.succeed([["002", "003"], Option.some(4)]))
  })

  test("an offset past the end fails with the line count; an empty text has an empty window", () => {
    expect(lineWindow("a\nb\n", { offset: 3, limit: 10, maxBytes: 100 })).toEqual(Result.fail(2))
    expect(lineWindow("", { offset: 1, limit: 10, maxBytes: 100 })).toEqual(Result.succeed({ lines: [], firstLine: 0, lastLine: 0, totalLines: 0, next: Option.none(), clipped: false }))
    expect(lineWindow("", { offset: 2, limit: 10, maxBytes: 100 })).toEqual(Result.fail(0))
  })

  test("a single line longer than the window is shown cut, and the next window starts after it", () => {
    const text = `${"é".repeat(40)}\nshort\n`
    const window = Result.getOrThrow(lineWindow(text, { offset: 1, limit: 10, maxBytes: 11 }))
    expect(window).toEqual({ lines: ["é".repeat(5)], firstLine: 1, lastLine: 1, totalLines: 2, next: Option.some(2), clipped: true })
  })

  test("CRLF lines are shown without their carriage return", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"])
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"])
  })

  test("property: following `next` from offset 1 shows every line exactly once", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ maxLength: 12 }).map((line) => line.replace(/[\r\n]/g, "")), { maxLength: 40 }),
      fc.integer({ min: 1, max: 7 }),
      fc.integer({ min: 16, max: 64 }),
      (all, limit, maxBytes) => {
        const text = all.join("\n")
        const expected = splitLines(text)
        const shown = (offset: number, sofar: ReadonlyArray<string>): ReadonlyArray<string> => {
          const window = lineWindow(text, { offset, limit, maxBytes })
          if (Result.isFailure(window)) return sofar
          const next = [...sofar, ...window.success.lines]
          return Option.match(window.success.next, { onNone: () => next, onSome: (line) => shown(line, next) })
        }
        expect(shown(1, [])).toEqual(expected)
      },
    ))
  })
})

describe("clipping", () => {
  test("clips by UTF-8 bytes without splitting a character", () => {
    expect(clipHead("aé😀b", 4)).toBe("aé")
    expect(clipHead("aé😀b", 7)).toBe("aé😀")
    expect(clipTail("aé😀b", 5)).toBe("😀b")
    expect(clipTail("aé😀b", 4)).toBe("b")
    expect(clipChars("ab😀", 3)).toEqual({ text: "ab", clipped: true })
    expect(clipChars("abc", 3)).toEqual({ text: "abc", clipped: false })
  })

  test("property: a clip is a prefix (or suffix) within the bytes, short of them by less than one character", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 30 }), fc.integer({ min: 0, max: 40 }), (text, maxBytes) => {
      const head = clipHead(text, maxBytes)
      const tail = clipTail(text, maxBytes)
      expect(text.startsWith(head) && text.endsWith(tail)).toBe(true)
      if (utf8Length(text) <= maxBytes) expect([head, tail]).toEqual([text, text])
      else {
        expect([utf8Length(head) <= maxBytes, utf8Length(head) > maxBytes - 4]).toEqual([true, true])
        expect([utf8Length(tail) <= maxBytes, utf8Length(tail) > maxBytes - 4]).toEqual([true, true])
      }
    }))
  })
})

describe("headLines and tailText", () => {
  test("headLines keeps the first lines within both limits", () => {
    expect(headLines(lines(10), 3, 1_000)).toEqual({ lines: ["001", "002", "003"], omitted: 7 })
    expect(headLines(lines(10), 100, 8)).toEqual({ lines: ["001", "002"], omitted: 8 })
    expect(headLines(["x".repeat(20)], 5, 8)).toEqual({ lines: ["x".repeat(8)], omitted: 0 })
  })

  test("tailText keeps the last lines within both limits, or the end of one long line", () => {
    expect(tailText(`${lines(10).join("\n")}\n`, 3, 1_000)).toEqual({ text: "008\n009\n010", shownLines: 3, totalLines: 10, truncated: true })
    expect(tailText("a\nb", 10, 1_000)).toEqual({ text: "a\nb", shownLines: 2, totalLines: 2, truncated: false })
    expect(tailText(`${lines(10).join("\n")}`, 100, 8)).toEqual({ text: "009\n010", shownLines: 2, totalLines: 10, truncated: true })
    expect(tailText(`start\n${"y".repeat(30)}`, 10, 6)).toEqual({ text: "yyyyyy", shownLines: 1, totalLines: 2, truncated: true })
  })

  test("text exactly as long as the limit is shown whole: no newline is counted after the last line", () => {
    const exact = "y".repeat(1_024)
    expect(tailText(exact, 10, 1_024)).toEqual({ text: exact, shownLines: 1, totalLines: 1, truncated: false })
    expect(tailText(`${exact}\n`, 10, 1_024)).toEqual({ text: exact, shownLines: 1, totalLines: 1, truncated: false })
    expect(tailText(`${exact}y`, 10, 1_024)).toMatchObject({ shownLines: 1, truncated: true })
    expect(Result.map(lineWindow(`${exact}\nnext\n`, { offset: 1, limit: 10, maxBytes: 1_024 }), (window) => [window.lines, window.clipped])).toEqual(Result.succeed([[exact], false]))
    expect(headLines(["abc", "def"], 10, 7)).toEqual({ lines: ["abc", "def"], omitted: 0 })
    expect(headLines(["abc", "def"], 10, 6)).toEqual({ lines: ["abc"], omitted: 1 })
  })

  test("property: lines that fit the limit exactly, joined, are all shown, and one byte less cuts them", () => {
    const line = fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }).map((text) => text.replace(/[\r\n]/g, "")).filter((text) => text.length > 0)
    fc.assert(fc.property(fc.array(line, { minLength: 1, maxLength: 12 }), (all) => {
      const text = all.join("\n")
      const size = utf8Length(text)
      expect(tailText(text, 100, size)).toMatchObject({ text, truncated: false })
      expect(tailText(`${text}\n`, 100, size)).toMatchObject({ text, truncated: false })
      expect(headLines(all, 100, size)).toEqual({ lines: all, omitted: 0 })
      expect(Result.getOrThrow(lineWindow(text, { offset: 1, limit: 100, maxBytes: size }))).toMatchObject({ lines: all, clipped: false, next: Option.none() })
      expect(tailText(text, 100, size - 1).truncated).toBe(true)
      const short = Result.getOrThrow(lineWindow(text, { offset: 1, limit: 100, maxBytes: size - 1 }))
      expect(short.lines.join("\n") !== text || short.clipped || Option.isSome(short.next)).toBe(true)
    }))
  })
})

describe("file content", () => {
  test("a NUL byte in the first 8 KB makes a file binary", () => {
    expect(looksBinary(new TextEncoder().encode("plain text"))).toBe(false)
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toBe(true)
    const late = new Uint8Array(10_000).fill(0x61)
    late[9_000] = 0
    expect(looksBinary(late)).toBe(false)
  })

  test("a BOM is removed when decoding and written back when encoding", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])
    expect(decodeText(bytes)).toEqual({ text: "hi", bom: true, lossy: false })
    expect(encodeText({ text: "hi", bom: true })).toBe("﻿hi")
    expect(decodeText(new TextEncoder().encode("﻿"))).toEqual({ text: "", bom: true, lossy: false })
    expect(decodeText(new TextEncoder().encode("hi"))).toEqual({ text: "hi", bom: false, lossy: false })
  })

  test("bytes that are not valid UTF-8 decode with U+FFFD and say lossy; valid ones (U+FFFD itself included) do not", () => {
    // "café\nx=1\n" in Latin-1: the é is the single byte E9.
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x3d, 0x31, 0x0a]))).toEqual({ text: "caf�\nx=1\n", bom: false, lossy: true })
    expect(decodeText(new TextEncoder().encode("café �"))).toEqual({ text: "café �", bom: false, lossy: false })
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0xff]))).toEqual({ text: "�", bom: true, lossy: true })
  })

  test("media types come from the name's extension", () => {
    expect(mediaTypeOf("img/logo.PNG")).toEqual(Option.some("image/png"))
    expect(mediaTypeOf("doc.pdf")).toEqual(Option.some("application/pdf"))
    expect(mediaTypeOf(".png")).toEqual(Option.none())
    expect(mediaTypeOf("dir.png/file")).toEqual(Option.none())
    expect(mediaTypeOf("notes.bin")).toEqual(Option.none())
  })

  test("byte counts read as people write them", () => {
    expect([formatBytes(812), formatBytes(51_200), formatBytes(1_536), formatBytes(33_554_432)]).toEqual(["812 B", "50 KB", "1.5 KB", "32 MB"])
  })
})
