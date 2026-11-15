// What a learner's file made is read as it came and held to a guard: a file
// that makes the wrong kind of thing is refused in words that name the file
// and the name, in every lesson, and nothing is thrown at the page.
import { afterEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { loadEcho } from "../models/mock.ts"
import { LessonRuntime } from "../runtime.ts"
import { lessonOf, lessonSlugs } from "./index.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

const NO_MEMORY = "memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …)."
const NO_HANDLERS = "tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … })."
const NO_PROGRAM = "agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."
/** tools.ts making two names that are no toolkit and no layer. */
const TWO_NUMBERS = "const tools = 1\nconst toolsLive = 2"

/** skills.ts with two skills written as plain objects, the first under a name no skill may have, and handlers that are no layer. */
const BY_HAND = `const units = { id: "Units", summary: "Convert.", instructions: "Convert.", tools: Toolkit.empty }
const haiku = { id: "haiku", summary: "Answer in a haiku.", instructions: "Three lines.", tools: Toolkit.empty }
const unitsLive = 3`

/** Each lesson's files, each made to give the wrong kind of thing: `[file, its text, what the build says]`. */
const WRONG: Record<string, ReadonlyArray<readonly [string, string, string]>> = {
  "your-first-agent": [["memory", "42", NO_MEMORY], ["agent", "const main = 42", NO_PROGRAM]],
  tools: [["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM]],
  "your-own-plugin": [
    ["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS],
    ["plugin", "const meter = 1\nconst withClock = 2", "plugin.ts did not run: meter is not a layer. It should be Layer.effectDiscard(…)."],
    ["plugin", "const meter = Layer.empty\nconst withClock = 2", "plugin.ts did not run: withClock is not a function. It should take the memory it wraps and return a layer."],
    ["agent", "const main = 42", NO_PROGRAM],
  ],
  "sub-agents": [
    ["memory", "42", NO_MEMORY],
    ["loop", "const runAgent = 1", "loop.ts did not run: runAgent is not a function. It should take an agent and return its turn."],
    ["tools", "const Helper = 1, helperTools = 1, tools = 1, helperToolsLive = 1, delegateLive = 1", "tools.ts did not run: helperToolsLive and delegateLive should be layers, made with toLayer."],
    ["agent", "const main = 42", NO_PROGRAM],
  ],
  compaction: [
    ["memory", "42", "memory.ts did not run: memory is not a layer. It should be summaryMemory({ … })."],
    ["summarizer", "42", "summarizer.ts did not run: summarizerLive is not a layer. It should be Layer.effect(Summarizer, …)."],
    ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM],
  ],
  render: [["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM]],
  "keep-the-conversation": [
    ["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS],
    ["store", "const store = 1", "store.ts did not run: store is not a function. It should take the storage and its options, and give a layer."],
    ["chat", "42", "chat.ts did not run: resume is not an Effect. It should give the conversation to go on with."],
    ["agent", "const main = 42", NO_PROGRAM],
  ],
  pointers: [["memory", "const flatMemory = 42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM]],
  approvals: [["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM]],
  skills: [
    ["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS],
    // A skill written by hand, never through defineSkill, that is none: `skills` checks it, and refuses in the kernel's words.
    [
      "skills", `${BY_HAND}\nconst skillSet = skills(tools, units, haiku)`,
      'skills.ts did not run: a skill\'s id is lower-case words joined by hyphens, at most 64 characters, such as "unit-converter": "Units" is none',
    ],
    ["skills", "const units = 1, haiku = 2, unitsLive = 3\nconst skillSet = skills(tools, units, haiku)", "skills.ts did not run: a skill is made with defineSkill({ id, summary, instructions, tools })"],
    // Values that never went through `skills` or `toLayer`.
    ["skills", "const units = 1, haiku = 2, unitsLive = 3, skillSet = 4", "skills.ts did not run: skillSet is not a skill set. It should be skills(tools, units, haiku)."],
    ["skills", `${BY_HAND}\nconst skillSet = { catalogue: "", offered: () => 1, handlers: 2, toolkit: tools }`, "skills.ts did not run: skillSet is not a skill set. It should be skills(tools, units, haiku)."],
    ["skills", `${BY_HAND.replace('"Units"', '"units"')}\nconst skillSet = skills(tools, units, haiku)`, "skills.ts did not run: unitsLive is not a layer. It should be units.tools.toLayer({ … })."],
    ["agent", "const main = 42", NO_PROGRAM],
  ],
}

describe("a learner's file that makes the wrong kind of thing", () => {
  test("every lesson of the site has its cases here, and every file a learner can edit has at least one", () => {
    // The table against the lesson list: a lesson added to the site and not here fails, and so does a case for no lesson.
    expect(Object.keys(WRONG)).toEqual([...lessonSlugs])
    for (const slug of lessonSlugs) {
      const lesson = Option.getOrThrow(lessonOf(slug))
      const editable = lesson.files.filter((file) => !file.readOnly).map((file) => file.id)
      const covered = new Set((WRONG[slug] ?? []).map(([file]) => file))
      expect({ slug, without: editable.filter((file) => !covered.has(file)) }).toEqual({ slug, without: [] })
    }
  })

  for (const [slug, cases] of Object.entries(WRONG)) {
    test(`${slug}: each file is refused in words that name it, and the lesson's own files build`, async () => {
      const lesson = Option.getOrThrow(lessonOf(slug))
      const runtime = await LessonRuntime.create(lesson)
      opened.push(runtime)
      runtime.setModel(loadEcho())
      const sources: Record<string, string> = Object.fromEntries(lesson.files.map((file) => [file.id, file.defaultText]))
      for (const [file, text, message] of cases) {
        // The file is one of the lesson's, so the case replaces a text the page runs.
        expect({ slug, file, known: file in sources }).toEqual({ slug, file, known: true })
        expect({ slug, file, text, result: await runtime.start({ ...sources, [file]: text }) }).toEqual({ slug, file, text, result: { _tag: "Refused", message } })
      }
      // The same runtime builds the lesson's own files afterwards: a refused build broke nothing.
      expect(await runtime.start(sources)).toEqual({ _tag: "Built" })
    })
  }
})
