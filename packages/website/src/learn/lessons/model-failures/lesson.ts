// Lesson 13, "When the model fails": a model call fails, and the loop asks
// for its answer under a plan, Effect's `ExecutionPlan` through the kernel's
// `planned`: the model picked is tried again, then the call goes to a spare.
// The base program over lesson 2's tools, memory and chat, and a new file,
// failures.ts: the calls of the model picked the page makes fail, so the
// lesson shows a failure on any model. The page hands agent.ts the model
// picked failing as that list says (`PageParts.failing`), as `model`, and a
// second Echo, as `spare`.
import { Effect, ExecutionPlan, Layer, Option, Predicate, Result, Schedule, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, Core, messageOf, vocabularyOf, readJournal, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { callTool, Memory, modelAnswer, paired, planned, promptMessage, retryable } from "@xandreed/sdk/kernel"
import { named, programOf, run, runStatements } from "../../evaluate.ts"
import type { Lesson, MadeFailure, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { cut, down, failsOnce, noWhile, planAlone, threeDown } from "./config-edit.ts"
import { DEFAULT_FAILURES, FAILURES_INTRO, failuresDocumentOf } from "./failures.source.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }

/** What agent.ts imports, and what the page gives it: the model picked, failing as failures.ts says, and the spare. */
const agentNames = (parts: PageParts, failures: ReadonlyArray<MadeFailure>, flatMemory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, ExecutionPlan, Schedule, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, planned, retryable, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, tools, toolsLive, pane: parts.pane,
  // Named by no import: the page's. `failing` is called once a build, so the list starts again with every build.
  model: parts.failing(failures),
  spare: parts.spare,
})

const NOT_A_LIST = "failures.ts did not run: failures is not a list of failures. It should be an array, each entry { retryable, pieces } or {}."

/** The fields an entry of failures.ts may have. */
const FIELDS: ReadonlyArray<string> = ["retryable", "pieces"]

/** One entry of failures.ts as the page makes it fail, or why it is no failure, in words that name the file. */
const failureOf = (entry: unknown, index: number): Result.Result<MadeFailure, string> => {
  const at = `entry ${index + 1} of failures`
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return Result.fail(`failures.ts did not run: ${at} is not a failure. It should be an object, such as { retryable: true }.`)
  const unknown = Object.keys(entry).filter((key) => !FIELDS.includes(key))
  if (unknown.length > 0) return Result.fail(`failures.ts did not run: ${at} has a field a failure does not have: ${unknown.join(", ")}. A failure has retryable, pieces, both or neither.`)
  const retryable = named(entry, "retryable")
  const pieces = named(entry, "pieces")
  if (retryable !== undefined && typeof retryable !== "boolean") return Result.fail(`failures.ts did not run: ${at} has a retryable that is not true or false.`)
  if (pieces === undefined) return Result.succeed(retryable === undefined ? {} : { retryable })
  const listed: ReadonlyArray<unknown> = Array.isArray(pieces) ? pieces : []
  if (!Array.isArray(pieces) || !listed.every(Predicate.isString)) return Result.fail(`failures.ts did not run: ${at} has pieces that are not a list of words, such as ["Half "].`)
  return Result.succeed({ ...(retryable === undefined ? {} : { retryable }), pieces: listed })
}

/** failures.ts as the page runs it: the list, each entry checked; or why it is no list of failures. */
export const failuresOf = (source: string): Result.Result<ReadonlyArray<MadeFailure>, string> =>
  Result.flatMap(run("failures.ts did not run: ", source, {}), (made) => {
    if (!Array.isArray(made)) return Result.fail(NOT_A_LIST)
    const entries: ReadonlyArray<unknown> = made
    return Result.all(entries.map(failureOf))
  })

/** memory.ts, tools.ts, failures.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(failuresOf(sources.failures ?? ""), (failures) =>
        Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, failures, parts.watchMemory(memory), tools, toolsLive)), (main) =>
          // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
          programOf(main)))
    })
  })

/** A note, a sum and a question about the notes, which one turn takes together: three calls in one step, then one answer. */
const THREE = ["Remember to buy milk.", "What is 12 * 3?", "What are my notes?"]

export const modelFailures: Lesson = {
  slug: "model-failures",
  files: [
    {
      id: "failures", label: "failures.ts", defaultText: DEFAULT_FAILURES, documentOf: failuresDocumentOf, editableFrom: FAILURES_INTRO.length, formatPrefix: "const failures = ",
      sections: [], folded: [], readOnly: false,
    },
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const flatMemory = ",
      sections: [], folded: [], readOnly: false,
    },
  ],
  mainFile: "failures",
  // A greeting, a sum and a note: a call with no tool, and calls with one.
  chips: ["Hello.", "What is 12 * 3?", "Remember to buy milk.", "What are my notes?"],
  // Sent at once, one turn takes all three: a note saved, a sum worked out and the notes read in one step.
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {},
  experiments: {
    "fails-once": { file: "failures", apply: failsOnce },
    down: { file: "failures", apply: down },
    cut: { file: "failures", apply: cut },
    "plan-alone": { file: "agent", apply: planAlone, also: [{ file: "failures", apply: cut }] },
    "no-while": { file: "agent", apply: noWhile, also: [{ file: "failures", apply: threeDown }] },
  },
  evaluate: evaluateLesson,
}
