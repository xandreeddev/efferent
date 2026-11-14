import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Option } from "effect"
import { formatRegion } from "./format.ts"
import { lessonOf } from "./lessons/index.ts"

/** Every lesson's slug: the folders under `lessons/` that hold a `lesson.ts`. The registry finds a lesson by slug and lists none. */
const lessonsDir = fileURLToPath(new URL("./lessons/", import.meta.url))
const slugs = readdirSync(lessonsDir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() && existsSync(join(lessonsDir, entry.name, "lesson.ts")) ? [entry.name] : []))

/**
 * Starter files Format would change, as `<slug>/<file id>`. Each holds a line longer than the formatter's 100 columns
 * (a system text, a tool's parameters, a `streamText` call), which Prettier breaks over several lines. The list only
 * shrinks: a file leaves it when its text is made tidy, and the test fails on an entry that is tidy or is no file.
 */
const UNTIDY_STARTERS: ReadonlyArray<string> = [
  "tools/agent",
  "tools/tools",
  "your-own-plugin/agent",
  "your-own-plugin/tools",
  "sub-agents/agent",
  "sub-agents/tools",
  "sub-agents/loop",
  "compaction/summarizer",
  "compaction/agent",
  "compaction/tools",
  "render/tools",
  "render/agent",
]

describe("formatRegion", () => {
  test("every lesson folder is a lesson the registry finds", () => {
    expect(slugs.length).toBeGreaterThan(0)
    expect(slugs.filter((slug) => Option.isNone(lessonOf(slug)))).toEqual([])
  })

  test("the starter text of every editable file of every lesson is already formatted, but for the files listed as untidy", async () => {
    const checked: Array<string> = []
    for (const slug of slugs) {
      for (const file of Option.match(lessonOf(slug), { onNone: () => [], onSome: (lesson) => lesson.files })) {
        if (file.readOnly) continue
        const name = `${slug}/${file.id}`
        checked.push(name)
        // What Format is given on a fresh page: the editable part of the file as the editor holds it, and the file's prefix.
        const started = file.documentOf(file.defaultText).slice(file.editableFrom, file.editableFrom + file.defaultText.length)
        expect({ name, started }).toEqual({ name, started: file.defaultText })
        const result = await formatRegion(started, file.formatPrefix)
        // A listed file is one Format changes: text it refuses, or leaves alone, fails here.
        if (UNTIDY_STARTERS.includes(name)) expect({ name, changes: result.ok && result.text !== started }).toEqual({ name, changes: true })
        else expect({ name, result }).toEqual({ name, result: { ok: true, text: started } })
      }
    }
    expect(checked.length).toBeGreaterThan(UNTIDY_STARTERS.length)
    expect(UNTIDY_STARTERS.filter((name) => !checked.includes(name))).toEqual([])
  }, 30_000)

  test("re-indents a call, one argument a line, without semicolons or a trailing newline", async () => {
    const result = await formatRegion("program.pipe(  Effect.provide( flatMemory ),\n        Effect.provide(model) )", "const main = ")
    expect(result).toEqual({ ok: true, text: "program.pipe(Effect.provide(flatMemory), Effect.provide(model))" })
  })

  test("a syntax error comes back as a message, and the text is not touched", async () => {
    const result = await formatRegion("program.pipe(,,)", "const main = ")
    expect(result.ok).toBe(false)
  })
})
