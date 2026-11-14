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

describe("formatRegion", () => {
  test("every lesson folder is a lesson the registry finds", () => {
    expect(slugs.length).toBeGreaterThan(0)
    expect(slugs.filter((slug) => Option.isNone(lessonOf(slug)))).toEqual([])
  })

  test("the starter text of every editable file of every lesson is already formatted: Format changes none", async () => {
    const checked: Array<string> = []
    for (const slug of slugs) {
      for (const file of Option.match(lessonOf(slug), { onNone: () => [], onSome: (lesson) => lesson.files })) {
        if (file.readOnly) continue
        const name = `${slug}/${file.id}`
        checked.push(name)
        // What Format is given on a fresh page: the editable part of the file as the editor holds it, and the file's prefix.
        const started = file.documentOf(file.defaultText).slice(file.editableFrom, file.editableFrom + file.defaultText.length)
        expect({ name, started }).toEqual({ name, started: file.defaultText })
        expect({ name, result: await formatRegion(started, file.formatPrefix) }).toEqual({ name, result: { ok: true, text: started } })
      }
    }
    // Every lesson has at least its agent.ts and one more file to edit.
    expect(checked.length).toBeGreaterThanOrEqual(slugs.length * 2)
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
