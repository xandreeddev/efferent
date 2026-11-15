// Lesson 12, "Test your agent": every part is replaceable, so a check swaps
// the model for a script and the chat for a list, runs the same program, and
// reads the journal. The base program with `program` exported, over lesson
// 2's tools, memory and chat, and a new file, checks.ts: the lines that run
// the program for a check, and the lesson's checks. The page runs them with
// lesson 7's button (`Lesson.kits`), each on a stack of its own, made of the
// kernel's own parts and the shown chat.ts, so the page hears nothing of a
// check.
import { Context, Effect, Fiber, Layer, Option, Queue, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { ConformanceFailure, CONVERSATION_VOCABULARY, Core, kernel, messageOf, readJournal, Sessions, turnStartedEvent, userMessage, vocabularyOf } from "@xandreed/core/kernel"
import { callTool, inProcessJournal, Memory, modelAnswer, paired, promptMessage, scriptedModel, sessions, turnsOf } from "@xandreed/sdk/kernel"
import { named, programOf, run, runStatements } from "../../evaluate.ts"
import type { KitCheck, Lesson, LessonKit, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { agentBodyOf, DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CHAT, chatBodyOf } from "./chat.source.ts"
import { CHECKS_HEADER, CHECKS_IMPORTS, checksBodyOf, checksDocumentOf, DEFAULT_CHECKS } from "./checks.source.ts"
import { breakCalculator, vacuous, withLive } from "./config-edit.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }
const chatNames = { Context, Effect, Layer, Queue, Stream, Sessions }

/**
 * What agent.ts is run with besides the names of `effect` and the kernel's functions: the base's parts, the chat,
 * and what the page gives and no import names (`pane`, `model`). The page's own program is given the page's
 * stand-ins; a check's is given the kernel's own parts and chat.ts as it is shown.
 */
interface Stack {
  readonly kernel: unknown
  readonly inProcessJournal: unknown
  readonly sessions: unknown
  readonly Chat: unknown
  readonly chatOn: unknown
  readonly pane: unknown
  readonly model: unknown
}

const agentNames = (stack: Stack, flatMemory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer,
  ...stack, flatMemory, tools, toolsLive,
})

/** What checks.ts imports: the kernel's own parts, and what the other files made for this check's stack. */
const checksNames = (made: { readonly program: unknown; readonly Chat: unknown; readonly chatOn: unknown; readonly flatMemory: unknown; readonly toolsLive: unknown; readonly model: unknown }) => ({
  Effect, Fiber, Option, Queue, ConformanceFailure, kernel, Sessions, inProcessJournal, scriptedModel, sessions, turnsOf,
  ...made,
})

/** What memory.ts, tools.ts and agent.ts made, run in that order over one stack. */
interface Made {
  readonly flatMemory: unknown
  readonly toolsLive: unknown
  readonly main: unknown
  readonly program: unknown
}

/**
 * memory.ts, tools.ts, then agent.ts, run with the stack given: what they made, or why one did not run. `memoryOf`
 * gives what agent.ts is handed as memory.ts's `flatMemory`: the page watches it, and a check takes it as the
 * file made it.
 */
const madeOn = (sources: Sources, stack: Stack, memoryOf: <E, R>(memory: Layer.Layer<Memory, E, R>) => unknown): Result.Result<Made, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      // agent.ts makes two names, `main` and `program`. One it does not define is read as undefined, and refused below in words.
      const both = '{ main: typeof main === "undefined" ? undefined : main, program: typeof program === "undefined" ? undefined : program }'
      return Result.map(runStatements("agent.ts did not run: ", agentBodyOf(sources.agent ?? ""), both, agentNames(stack, memoryOf(memory), tools, toolsLive)), (agent) =>
        ({ flatMemory: memory, toolsLive, main: named(agent, "main"), program: named(agent, "program") }))
    })
  })

/** A pane nothing draws on. A check's stack runs agent.ts for its `program`; the `main` the file also makes over this pane is never run. */
const NO_PANE = { onSend: () => {}, appendToAnswer: () => {}, finishAnswer: () => {}, showError: () => {}, showStatus: () => {} }

const NOT_A_LIST = "checks.ts did not run: checks is not a list of checks. It should be an array, each entry made with check(id, name, script, messages, holds)."

/** One entry of `checks` as the page runs it: an id, a name, and an Effect to run; or why it is no check, in words that name the file. */
const checkOf = (entry: unknown, index: number): Result.Result<KitCheck, string> => {
  const id = named(entry, "id")
  const name = named(entry, "name")
  if (typeof id !== "string" || typeof name !== "string") return Result.fail(`checks.ts did not run: entry ${index + 1} of checks is not a check. It should be { id, name, run }, as check(id, name, script, messages, holds) makes it.`)
  // A check's `run` is untyped JavaScript, as `main` is: what it needs is found when it runs.
  return Result.mapBoth(programOf(named(entry, "run")), {
    onFailure: () => `checks.ts did not run: the run of the check ${JSON.stringify(id)} is not an Effect. It should be the program run for the check, as check(id, name, script, messages, holds) makes it.`,
    onSuccess: (program) => ({ id, name, run: program }),
  })
}

/**
 * The checks of checks.ts, each on a stack of its own, or why a file did not run. Every file is run again for
 * them, apart from the page's program: tools.ts makes its notes anew, agent.ts is given the kernel's own `kernel`,
 * `inProcessJournal` and `sessions` where the page's program is given stand-ins, and its chat is chat.ts as it is
 * shown, with its types taken out. `model` is the model picked, which only a check that names it runs on.
 */
const checksOf = (sources: Sources, model: Layer.Layer<LanguageModel.LanguageModel>): Result.Result<ReadonlyArray<KitCheck>, string> =>
  Result.flatMap(runStatements("chat.ts did not run: ", chatBodyOf(CHAT), "{ Chat, chatOn }", chatNames), (chat) => {
    const stack = { kernel, inProcessJournal, sessions, Chat: named(chat, "Chat"), chatOn: named(chat, "chatOn"), pane: NO_PANE, model }
    return Result.flatMap(madeOn(sources, stack, (memory) => memory), ({ flatMemory, toolsLive, program }) => {
      if (!Effect.isEffect(program)) return Result.fail("agent.ts did not run: program is not an Effect. It should be the program main runs, exported so that checks.ts runs the same one.")
      const names = checksNames({ program, Chat: stack.Chat, chatOn: stack.chatOn, flatMemory, toolsLive, model })
      return Result.flatMap(runStatements("checks.ts did not run: ", checksBodyOf(sources.checks ?? ""), "checks", names), (checks) => {
        if (!Array.isArray(checks)) return Result.fail(NOT_A_LIST)
        const entries: ReadonlyArray<unknown> = checks
        return Result.all(entries.map(checkOf))
      })
    })
  })

/**
 * The files as the page runs them: `main`, ready to run, over the page's stand-ins and the page's chat. checks.ts
 * is run too, so a file that makes no list of checks refuses the build as any other file does; its checks are not
 * run here.
 */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(madeOn(sources, { kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, Chat, chatOn: parts.chatOn, pane: parts.pane, model: parts.model }, parts.watchMemory), ({ main }) =>
    // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
    Result.flatMap(programOf(main), (program) => Result.map(checksOf(sources, parts.model), () => program)))

/** How long one check may run on the page. A live check runs the model picked five times over, and a model on your machine is slow. */
export const CHECK_TIMEOUT = "2 minutes"

/** "Run checks": the checks of checks.ts, each run on its own stack. A live check needs the model picked. */
const checksKit: LessonKit = {
  checks: (sources, _storageOf, model) => Option.match(model, { onNone: () => Result.fail("Pick a model first."), onSome: (picked) => checksOf(sources, picked) }),
  timeout: CHECK_TIMEOUT,
  // A check runs the program, and a live one runs it on the model picked: the chat waits its turn.
  alone: true,
}

/** A note, a sum and a question about the notes, which one turn takes together: three calls in one step, then one answer. */
const THREE = ["Remember to buy milk.", "What is 2 + 3?", "What are my notes?"]

export const testYourAgent: Lesson = {
  slug: "test-your-agent",
  files: [
    {
      id: "checks", label: "checks.ts", defaultText: DEFAULT_CHECKS, documentOf: checksDocumentOf, editableFrom: CHECKS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: CHECKS_IMPORTS.length }) }], folded: [], readOnly: false,
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
  mainFile: "checks",
  chips: ["What is 2 + 3?", "What is 12 * 3?", "Remember to buy milk.", "What are my notes?"],
  // Sent at once, one turn takes all three: a note saved, a sum worked out and the notes read in one step.
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {},
  experiments: {
    "break-calculator": { file: "tools", apply: breakCalculator },
    vacuous: { file: "checks", apply: vacuous },
    live: { file: "checks", apply: withLive },
  },
  evaluate: evaluateLesson,
  kits: { checks: checksKit },
}
