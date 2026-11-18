import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { crc32Of, fileNameOf, firstLineOf, lineOf, linesOf } from "./directory-journal.entity.functions.js"

const bytesOf = (...parts: ReadonlyArray<Uint8Array | string>) => {
  const all = parts.map((part) => typeof part === "string" ? new TextEncoder().encode(part) : part)
  const joined = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  all.reduce((at, part) => { joined.set(part, at); return at + part.length }, 0)
  return joined
}

describe("a session file's lines", () => {
  test("a line is the CRC-32 of its JSON, a space, the JSON and a line break", () => {
    expect(crc32Of(new TextEncoder().encode("123456789"))).toBe("cbf43926")
    expect(new TextDecoder().decode(lineOf('{"a":"é"}'))).toBe(`${crc32Of(new TextEncoder().encode('{"a":"é"}'))} {"a":"é"}\n`)
  })

  test("every cut of a file after its last whole line is a torn tail, left out; the lines before it read as written", () => {
    const whole = bytesOf(lineOf('{"n":1}'), lineOf('{"n":"ünï"}'))
    const next = lineOf('{"n":3}')
    for (let cut = 0; cut < next.length; cut++) {
      expect(linesOf(bytesOf(whole, next.subarray(0, cut)))).toEqual(Result.succeed({ lines: ['{"n":1}', '{"n":"ünï"}'], whole: whole.length }))
    }
    expect(linesOf(bytesOf(whole, next))).toEqual(Result.succeed({ lines: ['{"n":1}', '{"n":"ünï"}', '{"n":3}'], whole: whole.length + next.length }))
  })

  test("a whole line whose bytes changed, or that has no CRC, is damage at its number", () => {
    const first = lineOf('{"n":1}')
    const second = lineOf('{"n":2}')
    const changed = second.slice()
    changed[12] = 0x33
    expect(linesOf(bytesOf(first, changed, lineOf('{"n":3}')))).toEqual(Result.fail({ line: 2 }))
    expect(linesOf(bytesOf(first, '{"n":2}\n'))).toEqual(Result.fail({ line: 2 }))
    expect(linesOf(bytesOf("\n"))).toEqual(Result.fail({ line: 1 }))
  })

  test("a listing reads the first line from a file's start alone", () => {
    expect(firstLineOf(bytesOf(lineOf('{"id":"s"}'), "half a li"))).toEqual(Result.succeed('{"id":"s"}'))
    expect(firstLineOf(bytesOf('{"id":"s"}'))).toEqual(Result.fail({ line: 1 }))
  })

  test("a session's file is named by its id when that is lower case, digits and hyphens, else by the id's bytes", () => {
    expect(["9b2c7a3e-1f0d-4c55-9a7e-0d1f2a3b4c5d", "kit-session", "Kit", "../x", "", "ü"].map(fileNameOf)).toEqual([
      "9b2c7a3e-1f0d-4c55-9a7e-0d1f2a3b4c5d.jsonl", "kit-session.jsonl", "~4b6974.jsonl", "~2e2e2f78.jsonl", "~.jsonl", "~c3bc.jsonl",
    ])
  })
})
