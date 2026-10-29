import { Option, Result } from "effect"
import type { DecodedText, HeadLines, LineWindow, OutputTail } from "./text-window.entity.js"

const encoder = new TextEncoder()
/** Keeps a U+FEFF where it is (the default decoder drops a leading one): a BOM is handled by `decodeText`. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
/** The same, refusing bytes that are not valid UTF-8 instead of replacing them. */
const strictDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true })

/** How many bytes `text` takes as UTF-8. */
export const utf8Length = (text: string): number => encoder.encode(text).length

const isContinuation = (bytes: Uint8Array, at: number): boolean => ((bytes[at] ?? 0) & 0xc0) === 0x80

/** The first byte of the character that `at` falls in (or `at` itself at a character's start). */
const startAtOrBefore = (bytes: Uint8Array, at: number): number =>
  at <= 0 ? 0 : at >= bytes.length ? bytes.length : isContinuation(bytes, at) ? startAtOrBefore(bytes, at - 1) : at

/** The first character start at or after `at`. */
const startAtOrAfter = (bytes: Uint8Array, at: number): number =>
  at >= bytes.length ? bytes.length : at > 0 && isContinuation(bytes, at) ? startAtOrAfter(bytes, at + 1) : Math.max(0, at)

/** The start of `text`, at most `maxBytes` of UTF-8, never cutting a character in two. */
export const clipHead = (text: string, maxBytes: number): string => {
  const bytes = encoder.encode(text)
  return bytes.length <= maxBytes ? text : decoder.decode(bytes.subarray(0, startAtOrBefore(bytes, maxBytes)))
}

/** The end of `text`, at most `maxBytes` of UTF-8, never cutting a character in two. */
export const clipTail = (text: string, maxBytes: number): string => {
  const bytes = encoder.encode(text)
  return bytes.length <= maxBytes ? text : decoder.decode(bytes.subarray(startAtOrAfter(bytes, bytes.length - maxBytes)))
}

/** The start of a line, at most `maxChars` UTF-16 code units, never splitting a surrogate pair; and whether anything was cut. */
export const clipChars = (line: string, maxChars: number): { readonly text: string; readonly clipped: boolean } => {
  if (line.length <= maxChars) return { text: line, clipped: false }
  const last = line.charCodeAt(maxChars - 1)
  return { text: line.slice(0, last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars), clipped: true }
}

/**
 * A text's lines: split at `\n`, with a `\r` before it dropped. A final
 * newline ends the last line rather than starting an empty one, so `""` has
 * no lines and `"a\n"` has one.
 */
export const splitLines = (text: string): ReadonlyArray<string> => {
  if (text.length === 0) return []
  const parts = text.split("\n")
  return (parts.at(-1) === "" ? parts.slice(0, -1) : parts).map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
}

/** How many of `lines`, from the first, fit in `maxBytes` once joined with `\n` (a newline counted between lines, none after the last). */
const fitting = (lines: ReadonlyArray<string>, maxBytes: number): number => {
  const totals = lines.reduce<Array<number>>((sums, line) => {
    sums.push(sums.length === 0 ? utf8Length(line) : (sums.at(-1) ?? 0) + 1 + utf8Length(line))
    return sums
  }, [])
  const over = totals.findIndex((total) => total > maxBytes)
  return over < 0 ? lines.length : over
}

/**
 * The lines `read` shows: from line `offset` (1-based), at most `limit` of
 * them and at most `maxBytes` of UTF-8, whole lines only, except that a
 * first line longer than `maxBytes` is shown cut (`clipped`) rather than
 * not at all. An empty text has an empty window at offset 1; an offset past
 * the last line fails with the number of lines there are.
 */
export const lineWindow = (text: string, options: { readonly offset: number; readonly limit: number; readonly maxBytes: number }): Result.Result<LineWindow, number> => {
  const all = splitLines(text)
  const start = options.offset - 1
  if (all.length === 0 && start === 0) return Result.succeed({ lines: [], firstLine: 0, lastLine: 0, totalLines: 0, next: Option.none(), clipped: false })
  if (start >= all.length) return Result.fail(all.length)
  const candidate = all.slice(start, start + options.limit)
  const count = fitting(candidate, options.maxBytes)
  const clipped = count === 0
  const lines = clipped ? [clipHead(candidate[0] ?? "", options.maxBytes)] : candidate.slice(0, count)
  const lastLine = start + lines.length
  return Result.succeed({
    lines, firstLine: options.offset, lastLine, totalLines: all.length,
    next: lastLine < all.length ? Option.some(lastLine + 1) : Option.none(), clipped,
  })
}

/** The first lines of a list that fit `maxLines` and `maxBytes` (a first line longer than `maxBytes` is cut), and how many were left out. */
export const headLines = (lines: ReadonlyArray<string>, maxLines: number, maxBytes: number): HeadLines => {
  const capped = lines.slice(0, maxLines)
  const count = fitting(capped, maxBytes)
  const kept = count === 0 && capped.length > 0 ? [clipHead(capped[0] ?? "", maxBytes)] : capped.slice(0, count)
  return { lines: kept, omitted: lines.length - kept.length }
}

/**
 * The end of a command's output: its last whole lines within `maxLines` and
 * `maxBytes`, or, when the last line alone is longer than `maxBytes`, that
 * line's end.
 */
export const tailText = (text: string, maxLines: number, maxBytes: number): OutputTail => {
  const all = splitLines(text)
  const capped = all.slice(Math.max(0, all.length - maxLines))
  const count = fitting([...capped].reverse(), maxBytes)
  const kept = count === 0 && capped.length > 0 ? [clipTail(capped.at(-1) ?? "", maxBytes)] : capped.slice(capped.length - count)
  return { text: kept.join("\n"), shownLines: kept.length, totalLines: all.length, truncated: kept.length < all.length || (count === 0 && capped.length > 0) }
}

/** Whether bytes look binary: a NUL byte in the first 8 KB. */
export const looksBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8_192).includes(0)

/**
 * A file's bytes as UTF-8 text, its BOM removed and remembered. Bytes that
 * are not valid UTF-8 (Latin-1, Windows-1252, Shift-JIS) are decoded all
 * the same, their invalid sequences as U+FFFD, and the result says `lossy`:
 * fit to show or search, not to write back.
 */
export const decodeText = (bytes: Uint8Array): DecodedText => {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = bom ? bytes.subarray(3) : bytes
  return Result.match(Result.try(() => strictDecoder.decode(body)), {
    onSuccess: (text) => ({ text, bom, lossy: false }),
    onFailure: () => ({ text: decoder.decode(body), bom, lossy: true }),
  })
}

/** Text to write back: with its BOM again when it had one. */
export const encodeText = (decoded: Pick<DecodedText, "text" | "bom">): string => decoded.bom ? `﻿${decoded.text}` : decoded.text

const mediaTypes: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"],
  ["bmp", "image/bmp"], ["ico", "image/x-icon"], ["tif", "image/tiff"], ["tiff", "image/tiff"], ["avif", "image/avif"],
  ["heic", "image/heic"], ["pdf", "application/pdf"], ["zip", "application/zip"], ["gz", "application/gzip"],
  ["tar", "application/x-tar"], ["wasm", "application/wasm"], ["mp3", "audio/mpeg"], ["wav", "audio/wav"],
  ["mp4", "video/mp4"], ["webm", "video/webm"], ["woff", "font/woff"], ["woff2", "font/woff2"], ["ttf", "font/ttf"], ["otf", "font/otf"],
])

/** The media type a file name's extension suggests, for binary files the tools do not open. */
export const mediaTypeOf = (name: string): Option.Option<string> => {
  const base = name.slice(name.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? Option.none() : Option.fromNullishOr(mediaTypes.get(base.slice(dot + 1).toLowerCase()))
}

/** A byte count for people: `812 B`, `50 KB`, `1.5 MB`. */
export const formatBytes = (bytes: number): string =>
  bytes < 1_024 ? `${bytes} B`
    : bytes < 1_048_576 ? `${Number.isInteger(bytes / 1_024) ? bytes / 1_024 : (bytes / 1_024).toFixed(1)} KB`
    : `${Number.isInteger(bytes / 1_048_576) ? bytes / 1_048_576 : (bytes / 1_048_576).toFixed(1)} MB`
