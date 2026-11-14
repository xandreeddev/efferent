// The system-text control over both forms of its line: on one line, and as
// Format wraps a long one (`const system =`, then the string on the next
// line). Pressing Format must never grey the control out.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { formatRegion } from "../../format.ts"
import { lessonOf } from "../index.ts"
import { DEFAULT_AGENT as TOOLS_AGENT } from "../tools/agent.source.ts"
import { DEFAULT_AGENT } from "./agent.source.ts"
import { readSystem, writeSystem } from "./config-edit.ts"

const ONE_LINE = 'const system = "You are a friendly tutor. Keep answers short."'
const WRAPPED = 'const system =\n  "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."'
const LONG = "You are a careful assistant. Say what you are about to do, do it with a tool, then answer in one sentence."

/** The text as the Format button leaves it. */
const format = async (text: string): Promise<string> => {
  const result = await formatRegion(text, "")
  expect(result).toMatchObject({ ok: true })
  return result.ok ? result.text : ""
}

describe("the system-text control", () => {
  test("reads the one-line form, and writes the string in place", () => {
    expect(DEFAULT_AGENT).toContain(ONE_LINE)
    expect(readSystem(DEFAULT_AGENT)).toEqual(Option.some("You are a friendly tutor. Keep answers short."))
    const written = Option.getOrThrow(writeSystem(DEFAULT_AGENT, "You are a pirate."))
    expect(written).toBe(DEFAULT_AGENT.replace(ONE_LINE, 'const system = "You are a pirate."'))
    expect(readSystem(written)).toEqual(Option.some("You are a pirate."))
  })

  test("reads the wrapped form, and writes the string in place, on its own line", () => {
    expect(TOOLS_AGENT).toContain(WRAPPED)
    expect(readSystem(TOOLS_AGENT)).toEqual(Option.some("You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."))
    const written = Option.getOrThrow(writeSystem(TOOLS_AGENT, "You are a pirate."))
    expect(written).toBe(TOOLS_AGENT.replace(WRAPPED, 'const system =\n  "You are a pirate."'))
    expect(readSystem(written)).toEqual(Option.some("You are a pirate."))
  })

  test("a text with quotes, a backslash and a line break is read back as written, in both forms", () => {
    const text = 'Say "arr" \\ always.\nOn two lines.'
    for (const agent of [DEFAULT_AGENT, TOOLS_AGENT]) {
      expect(Option.flatMap(writeSystem(agent, text), readSystem)).toEqual(Option.some(text))
    }
  })

  test("a long text typed into the one-line form: Format wraps the line, and the control still reads and writes it", async () => {
    const typed = Option.getOrThrow(writeSystem(DEFAULT_AGENT, LONG))
    expect(typed).toContain(`const system = ${JSON.stringify(LONG)}`)
    const formatted = await format(typed)
    expect(formatted).toContain(`const system =\n  ${JSON.stringify(LONG)}`)
    expect(readSystem(formatted)).toEqual(Option.some(LONG))
    expect(Option.flatMap(writeSystem(formatted, "Short."), readSystem)).toEqual(Option.some("Short."))
  })

  test("a short text typed into the wrapped form: Format joins the line, and the control still reads and writes it", async () => {
    const typed = Option.getOrThrow(writeSystem(TOOLS_AGENT, "Short."))
    expect(typed).toContain('const system =\n  "Short."')
    const formatted = await format(typed)
    expect(formatted).toContain('const system = "Short."')
    expect(readSystem(formatted)).toEqual(Option.some("Short."))
    expect(Option.flatMap(writeSystem(formatted, LONG), readSystem)).toEqual(Option.some(LONG))
  })

  test("in every lesson, the control reads the same system text from the starter code before and after Format", async () => {
    const read: Array<string> = []
    for (const slug of ["your-first-agent", "tools", "your-own-plugin", "sub-agents", "compaction", "render"]) {
      const lesson = Option.getOrThrow(lessonOf(slug))
      const control = Option.getOrThrow(Option.fromNullishOr(lesson.controls.system))
      const file = Option.getOrThrow(Option.fromNullishOr(lesson.files.find((one) => one.id === control.file)))
      const before = control.read(file.defaultText)
      expect({ slug, read: Option.isSome(before) }).toEqual({ slug, read: true })
      expect({ slug, after: control.read(await format(file.defaultText)) }).toEqual({ slug, after: before })
      read.push(slug)
    }
    expect(read).toHaveLength(6)
  }, 30_000)

  test("a line rewritten beyond recognition is left alone", () => {
    const rewritten = DEFAULT_AGENT.replace(ONE_LINE, "const system = [\"You are\", \"a tutor.\"].join(\" \")")
    expect(rewritten).not.toBe(DEFAULT_AGENT)
    expect(readSystem(rewritten)).toEqual(Option.none())
    expect(writeSystem(rewritten, "x")).toEqual(Option.none())
  })
})
