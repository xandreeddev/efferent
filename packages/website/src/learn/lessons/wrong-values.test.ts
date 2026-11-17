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
const NO_EXPORTED_PROGRAM = "agent.ts did not run: program is not an Effect. It should be the program main runs, exported so that checks.ts runs the same one."
const NO_CHECKS = "checks.ts did not run: checks is not a list of checks. It should be an array, each entry made with check(id, name, script, messages, holds)."
const NO_FAILURES = "failures.ts did not run: failures is not a list of failures. It should be an array, each entry { retryable, pieces } or {}."
const NO_GRAPH_MEMORY = "memory.ts did not run: memory is not a layer. It should be withGraph({ hops, limit, speaker })(flatMemory)."
const NO_HOPS = "memory.ts did not run: withGraph needs hops, a whole number from 1 to 3: how many links away from what a question names it walks. It was given"
const NO_DATASET = "evals.ts did not run: dataset is not a dataset. It should be { id, version, input, reference, cases }, with input and reference schemas and cases a list."
/** Lesson 13's evals.ts with a dataset of no case: what the cases after it change is held alone. */
const EMPTY_SET = 'const dataset = { id: "d", version: "1", input: Schema.String, reference: Schema.String, cases: [] }'
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
  remember: [
    ["memory", "const memory = 42", "memory.ts did not run: memory is not a layer. It should be withFacts({ limit: 5 })(flatMemory)."],
    // The wrapper made and never given a memory is a function, not a layer.
    ["memory", "const memory = withFacts({ limit: 5 })", "memory.ts did not run: memory is not a layer. It should be withFacts({ limit: 5 })(flatMemory)."],
    // A limit the kernel refuses is refused as the file runs, in the kernel's words: none, a fraction, and a memory where the options go.
    ["memory", "const memory = withFacts({ limit: 0 })(flatMemory)", "memory.ts did not run: withFacts needs a limit, a whole number of at least 1: the most facts a request is sent. It was given 0"],
    ["memory", "const memory = withFacts({ limit: 1.5 })(flatMemory)", "memory.ts did not run: withFacts needs a limit, a whole number of at least 1: the most facts a request is sent. It was given 1.5"],
    ["memory", "const memory = withFacts(flatMemory)", "memory.ts did not run: withFacts needs a limit, a whole number of at least 1: the most facts a request is sent. It was given undefined"],
    ["tools", TWO_NUMBERS, "tools.ts did not run: tools is not a toolkit. It should be Toolkit.merge(Toolkit.make(calculator), factTools)."],
    // A toolkit's tools by themselves are no toolkit: nothing yields its handlers.
    ["tools", "const tools = factTools.tools\nconst toolsLive = 2", "tools.ts did not run: tools is not a toolkit. It should be Toolkit.merge(Toolkit.make(calculator), factTools)."],
    ["tools", "const tools = factTools\nconst toolsLive = 2", "tools.ts did not run: toolsLive is not a layer. It should be Toolkit.make(calculator).toLayer({ … })."],
    ["agent", "const main = 42", NO_PROGRAM],
  ],
  "test-your-agent": [
    ["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM],
    // agent.ts makes two names, and checks.ts runs the second: a `program` that is no Effect, or that the file no longer makes, is refused too.
    ["agent", "const program = 42\nconst main = Effect.void", NO_EXPORTED_PROGRAM], ["agent", "const main = Effect.void", NO_EXPORTED_PROGRAM],
    ["checks", "const checks = 42", NO_CHECKS],
    // The function that makes a check, never called, is no list.
    ["checks", "const checks = () => []", NO_CHECKS],
    ["checks", "const checks = [1]", "checks.ts did not run: entry 1 of checks is not a check. It should be { id, name, run }, as check(id, name, script, messages, holds) makes it."],
    [
      "checks", 'const checks = [{ id: "sum", name: "a sum", run: Effect.void }, { id: "other", name: "another", run: () => 1 }]',
      'checks.ts did not run: the run of the check "other" is not an Effect. It should be the program run for the check, as check(id, name, script, messages, holds) makes it.',
    ],
  ],
  evals: [
    ["tools", TWO_NUMBERS, NO_HANDLERS],
    // evals.ts makes four names, each held to its kind before anything of the eval runs.
    ["evals", "const dataset = 1, evaluators = [], repetitions = 5, gates = []", NO_DATASET],
    ["evals", "const dataset = { id: \"d\", version: \"1\", input: 1, reference: 2, cases: [] }, evaluators = [], repetitions = 5, gates = []", NO_DATASET],
    [
      "evals", "const dataset = { id: \"d\", version: \"1\", input: Schema.String, reference: Schema.String, cases: [1] }, evaluators = [], repetitions = 5, gates = []",
      "evals.ts did not run: case 1 of the dataset is not a case. It should be { id, family, split, review, input, reference, provenance }.",
    ],
    ["evals", `${EMPTY_SET}, evaluators = [{ id: "answer" }], repetitions = 5, gates = []`, "evals.ts did not run: evaluators is not a list of graders. It should be an array, each entry { id, version, metrics, run }."],
    ["evals", `${EMPTY_SET}, evaluators = [], repetitions = 0, gates = []`, "evals.ts did not run: repetitions is not a whole number of at least 1."],
    ["evals", `${EMPTY_SET}, evaluators = [], repetitions = 2.5, gates = []`, "evals.ts did not run: repetitions is not a whole number of at least 1."],
    [
      "evals", `${EMPTY_SET}, evaluators = [], repetitions = 5, gates = {}`,
      "evals.ts did not run: gates is not a list of gates. It should be an array, each entry { grader, metric, aggregate, mode, minimum, maximum, requiresReviewedReference }.",
    ],
  ],
  "model-failures": [
    ["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM],
    // failures.ts is one list, of entries each with retryable, pieces, both or neither.
    ["failures", "{ retryable: true }", NO_FAILURES],
    ["failures", '"[{ retryable: true }]"', NO_FAILURES],
    ["failures", "[true]", "failures.ts did not run: entry 1 of failures is not a failure. It should be an object, such as { retryable: true }."],
    ["failures", "[{}, { retriable: true }]", "failures.ts did not run: entry 2 of failures has a field a failure does not have: retriable. A failure has retryable, pieces, both or neither."],
    ["failures", '[{ retryable: "yes" }]', "failures.ts did not run: entry 1 of failures has a retryable that is not true or false."],
    ["failures", '[{ pieces: "Half " }]', 'failures.ts did not run: entry 1 of failures has pieces that are not a list of words, such as ["Half "].'],
    ["failures", "[{ pieces: [1] }]", 'failures.ts did not run: entry 1 of failures has pieces that are not a list of words, such as ["Half "].'],
  ],
  branches: [
    ["memory", "42", NO_MEMORY], ["tools", TWO_NUMBERS, NO_HANDLERS], ["agent", "const main = 42", NO_PROGRAM],
    ["chat", "42", "chat.ts did not run: resume is not an Effect. It should give the conversation to go on with."],
    // branch.ts makes one function, which the page calls when a branch is asked for: a value that is none refuses the build.
    ["branch", "const branchFrom = 1", "branch.ts did not run: branchFrom is not a function. It should take the conversation and a turn, and give the branch Sessions.fork makes."],
    ["branch", "const branchFrom = Effect.void", "branch.ts did not run: branchFrom is not a function. It should take the conversation and a turn, and give the branch Sessions.fork makes."],
  ],
  workspace: [
    ["agent", "const main = 42", NO_PROGRAM],
    // workspace.ts makes one function, which the page calls with its files: a value that is none, a function that
    // throws, and one that gives no layer each refuse the build in words that name the file.
    ["workspace", "const workspace = 1", "workspace.ts did not run: workspace is not a function. It should take the page's files, and give them as a layer."],
    ["workspace", "const workspace = (files) => 42", "workspace.ts did not run: workspace(files) is not a layer. It should give the page's files, or a layer over them."],
    ["workspace", 'const workspace = (files) => { throw new Error("no files today") }', "workspace.ts did not run: workspace(files) threw: no files today"],
    ["workspace", "const workspace = (files) => Files", "workspace.ts did not run: workspace(files) is not a layer. It should give the page's files, or a layer over them."],
  ],
  "background-tasks": [
    ["agent", "const main = 42", NO_PROGRAM],
    // helper.ts makes one function, the work of a task, which the tasks plugin calls: a value that is none refuses the build.
    ["helper", "const helper = 42", "helper.ts did not run: helper is not a function. It should take the task's session and its text, and give the task's answer."],
    ["helper", "const helper = Effect.succeed(\"done\")", "helper.ts did not run: helper is not a function. It should take the task's session and its text, and give the task's answer."],
  ],
  "connected-memory": [
    ["memory", "const memory = 42", NO_GRAPH_MEMORY],
    // The wrapper made and never given a memory is a function, not a layer.
    ["memory", "const memory = withGraph({ hops: 2, limit: 5 })", NO_GRAPH_MEMORY],
    // Options the kernel refuses are refused as the file runs, in the kernel's words: a walk too long, no limit, a
    // speaker's word of two words, and a memory where the options go.
    ["memory", "const memory = withGraph({ hops: 4, limit: 5 })(flatMemory)", `${NO_HOPS} 4`],
    ["memory", "const memory = withGraph({ hops: 2, limit: 0 })(flatMemory)", "memory.ts did not run: withGraph needs a limit, a whole number from 1 to 50: the most links a request is sent. It was given 0"],
    [
      "memory", 'const memory = withGraph({ hops: 2, limit: 5, speaker: { name: "user", words: ["my name"] } })(flatMemory)',
      'memory.ts did not run: withGraph\'s speaker needs a name with a letter or a digit, and words that are each one word, such as "me"',
    ],
    ["memory", "const memory = withGraph(flatMemory)", `${NO_HOPS} undefined`],
    ["tools", TWO_NUMBERS, "tools.ts did not run: tools is not a toolkit. It should be Toolkit.merge(Toolkit.make(calculator), graphTools)."],
    ["tools", "const tools = graphTools\nconst toolsLive = 2", "tools.ts did not run: toolsLive is not a layer. It should be Toolkit.make(calculator).toLayer({ … })."],
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
