// The workbench runs any lesson's definition, not only lesson 1's: a second
// definition, with one file and names of its own, builds and answers through
// the same runtime.
import { afterEach, describe, expect, test } from "bun:test"
import { Layer, Option, Result } from "effect"
import { inbox, settings, stepLoop, windowMemory } from "@xandreed/sdk/kernel"
import { checkedLayer, run } from "../evaluate.ts"
import type { Lesson } from "../lesson.ts"
import { loadEcho } from "../models/mock.ts"
import { LessonRuntime } from "../runtime.ts"
import { lessonOf } from "./index.ts"

/** A lesson the site does not have: one file, `stack.ts`, whose names differ from lesson 1's. */
const other: Lesson = {
  slug: "other",
  files: [{
    id: "stack",
    label: "stack.ts",
    defaultText: `inbox.pipe(Layer.provideMerge(stepLoop), Layer.provideMerge(window(500)), Layer.provideMerge(settings({ system: "Be brief." })))`,
    documentOf: (editable) => `const Stack = ${editable}`,
    editableFrom: "const Stack = ".length,
    formatPrefix: "const Stack = ",
    sections: [],
  }],
  mainFile: "stack",
  chips: [],
  three: [],
  fill: [],
  controls: {},
  experiments: {},
  raisedBudget: () => Option.none(),
  evaluate: (sources) => run("stack.ts did not run: ", sources.stack ?? "", {
    Layer: checkedLayer("window(500)"), inbox, stepLoop, settings,
    window: (budgetTokens: number) => windowMemory({ budgetTokens }),
  }),
}

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

describe("lesson definitions", () => {
  test("the site's lessons are found by slug, and an unknown slug by none", () => {
    expect(Option.map(lessonOf("your-first-agent"), (lesson) => lesson.files.map((file) => file.id))).toEqual(Option.some(["agent", "tiny"]))
    expect(lessonOf("no-such-lesson")).toEqual(Option.none())
  })

  test("a second definition builds its own file with its own names and answers through the same runtime", async () => {
    const runtime = await LessonRuntime.create(other.evaluate)
    opened.push(runtime)
    runtime.setModel(loadEcho())
    expect(await runtime.rebuild({ stack: other.files[0]!.defaultText })).toEqual({ _tag: "Built" })
    const [sent] = await runtime.send(["Hello"])
    expect(await sent!.outcome).toMatchObject({ _tag: "Replied" })
    // Lesson 1's names are not in scope here: its memory is not, and the failure names this lesson's file.
    expect(await runtime.rebuild({ stack: "lastMessages" })).toMatchObject({ _tag: "Refused", message: expect.stringContaining("stack.ts did not run: ") })
  })

  test("a lesson's evaluate refuses in words, before anything is built", () => {
    expect(other.evaluate({ stack: "inbox.pipe(Layer.provideMerge(window))" })).toEqual(
      Result.fail("stack.ts did not run: Layer.provideMerge was given a function, not a layer. Call it: window(500)."),
    )
    expect(Layer.isLayer(Result.getOrThrow(other.evaluate({ stack: other.files[0]!.defaultText })))).toBe(true)
  })
})
