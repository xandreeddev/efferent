import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fc from "fast-check"
import { Option } from "effect"
import { decodeRgMessage, emptyRgSearch, foldRgMessage, rgLines, rgRecords, ripgrepCommand, shellQuote } from "./ripgrep.entity.functions.js"
import { workspaceToolsDefaults } from "./workspace-tools.entity.js"

const record = (type: string, data: unknown) => JSON.stringify({ type, data })
const line = (type: string, number: number, text: string) => record(type, { path: { text: "a.txt" }, lines: { text: text + "\n" }, line_number: number })

test("shellQuote round-trips one literal argument through a POSIX shell", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom("a", " ", "'", '"', "\n", "$", "`", "\\", ";", "*", "é", "☃"), { maxLength: 80 }), (chars) => {
    const value = chars.join("")
    const result = spawnSync("sh", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(value)
  }), { numRuns: 60 })
})

test("rg arguments quote every word and carry all policy flags, never the pattern", () => {
  const command = ripgrepCommand(workspaceToolsDefaults, { pattern: "$(bad);'", glob: "**/*.ts", ignoreCase: true, literal: true, context: 2 }, "a'b", 4, ["node_modules", "./generated/**"])
  expect(command).toBe("'rg' '--json' '--no-config' '--sort' 'path' '--hidden' '--no-follow' '--no-ignore' '--max-filesize' '33554432' '--max-count' '5' '-C' '2' '-i' '-F' '-f' '-' '--glob=**/*.ts' '--glob=!node_modules' '--glob=!/generated/**' '--' 'a'\\''b'")
  expect(ripgrepCommand({ ...workspaceToolsDefaults, grepIgnoreFiles: true }, { pattern: "x" }, ".", 2, [])).not.toContain("--no-ignore")
})

test("JSON messages tolerate chunk splits, decode bytes and discard binary matches", () => {
  const bytes = record("match", { path: { bytes: "Y2Fm6S50eHQ=" }, lines: { bytes: "aGl0/w0K" }, line_number: 3 })
  const parsed = rgRecords("", bytes.slice(0, 29))
  expect(parsed.records).toEqual([])
  const rest = rgRecords(parsed.buffer, bytes.slice(29) + "\n" + line("context", 4, "after") + "\n")
  expect(rest.buffer).toBe("")
  expect(rest.records[0]).toMatchObject({ type: "match", data: { path: { bytes: "caf�.txt" }, lines: { bytes: "hit�\r\n" } } })
  const options = { limit: 5, perFile: 5, lineChars: 16, display: (path: string) => path }
  const found = foldRgMessage(emptyRgSearch, Option.getOrThrow(decodeRgMessage(line("match", 1, "hit"))), options)
  const end = Option.getOrThrow(decodeRgMessage(record("end", { path: { text: "a.txt" }, binary_offset: 5 })))
  expect(foldRgMessage(found, end, options)).toMatchObject({ lines: [], skipped: 1 })
})

test("caps count matching lines rather than occurrences and keep selected context", () => {
  const records = [line("context", 1, "before"), line("match", 2, "hit hit"), line("context", 3, "after"), line("match", 8, "extra"), line("context", 9, "not selected")]
  const found = records.reduce((state, text) => foldRgMessage(state, Option.getOrThrow(decodeRgMessage(text)), { limit: 3, perFile: 1, lineChars: 16, display: (path) => path }), emptyRgSearch)
  expect([...found.counts.values()]).toEqual([1])
  expect(found.truncated).toBe(true)
  expect(rgLines(found, 1)).toEqual([
    { path: "a.txt", line: 1, text: "before", match: false },
    { path: "a.txt", line: 2, text: "hit hit", match: true },
    { path: "a.txt", line: 3, text: "after", match: false },
  ])
  expect(foldRgMessage(found, Option.getOrThrow(decodeRgMessage(line("match", 11, "stop"))), { limit: 1, perFile: 5, lineChars: 16, display: (path) => path }).stopAtEnd).toBe(true)
})

test("a capped matching line still appears as context around a selected hit", () => {
  const state = [line("match", 1, "first"), line("match", 2, "second")].reduce((search, json) => foldRgMessage(search, Option.getOrThrow(decodeRgMessage(json)), { limit: 10, perFile: 1, lineChars: 16, display: (path) => path }), emptyRgSearch)
  expect(rgLines(state, 1)).toEqual([{ path: "a.txt", line: 1, text: "first", match: true }, { path: "a.txt", line: 2, text: "second", match: false }])
})

test("framing is independent of Bash chunk boundaries", () => {
  const transcript = line("match", 1, "hit") + "\n" + line("context", 2, "context") + "\n"
  const all = rgRecords("", transcript).records
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: transcript.length }), { maxLength: 30 }), (cuts) => {
    const ends = [0, ...cuts, transcript.length].sort((a, b) => a - b)
    const chunks = ends.slice(1).map((end, at) => transcript.slice(ends[at], end))
    const decoded = chunks.reduce((state, chunk) => {
      const parsed = rgRecords(state.buffer, chunk)
      return { buffer: parsed.buffer, records: [...state.records, ...parsed.records] }
    }, { buffer: "", records: [] as typeof all })
    expect(decoded).toEqual({ buffer: "", records: all })
  }), { numRuns: 50 })
})
