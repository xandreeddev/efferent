// Lesson 17, "Background tasks": hand work to a helper that works while you
// keep chatting. The base program with the kernel's two task tools merged into
// its toolkit, the tasks plugin over helper.ts's helper, and the page's
// `reportsOn(pane)` (`PageParts.reportsOn`): a task's report goes into the
// chat's one queue, behind the messages that came before it, and the loop
// answers it in a turn of its own. helper.ts is the work of one task, a small
// loop over tools.ts's tools; tools.ts
// and memory.ts are lesson 2's, shown read-only: the page runs their starter
// text. chat.ts is this lesson's, read-only: the page's own chat is the same
// queue over its pane.
import { Effect, Layer, Option, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, Core, messageOf, readJournal, Sessions, turnStartedEvent, userMessage, vocabularyOf } from "@xandreed/core"
import { callTool, Memory, modelAnswer, paired, promptMessage, taskHandlers, taskReport, tasks, taskTools } from "@xandreed/sdk"
import { programOf, run, runStatements, named } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { DEFAULT_MEMORY, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CHAT } from "./chat.source.ts"
import { instant, oneAtATime } from "./config-edit.ts"
import { DEFAULT_HELPER, HELPER_HEADER, HELPER_IMPORTS, helperBodyOf, helperDocumentOf } from "./helper.source.ts"

/** The read-only files as the page runs them: lesson 2's starter text, whatever any other tab holds. */
const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }
const helperNames = (tools: unknown) => ({ Effect, LanguageModel, Prompt, userMessage, callTool, Memory, modelAnswer, tools })

const agentNames = (parts: PageParts, flatMemory: unknown, tools: unknown, toolsLive: unknown, helper: unknown) => ({
  Effect, Stream, LanguageModel, Prompt, Toolkit,
  Core, Sessions, turnStartedEvent, userMessage,
  callTool, Memory, modelAnswer, taskHandlers, taskReport, tasks, taskTools, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, tools, toolsLive, helper,
  // Named by no import: the page's, as `pane` and `model` are. Where a task's report goes is the host's part.
  reportsOn: parts.reportsOn,
  pane: parts.pane, model: parts.model,
})

const NOT_A_FUNCTION = "helper.ts did not run: helper is not a function. It should take the task's session and its text, and give the task's answer."

/** helper.ts as the page runs it: the learner's `helper`, held to a function, or why it is none, in words that name the file. */
const helperOf = (sources: Sources, tools: unknown): Result.Result<unknown, string> =>
  Result.flatMap(runStatements("helper.ts did not run: ", helperBodyOf(sources.helper ?? ""), "helper", helperNames(tools)), (helper) =>
    Predicate.isFunction(helper) ? Result.succeed(helper) : Result.fail(NOT_A_FUNCTION))

/** memory.ts, tools.ts, helper.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", DEFAULT_MEMORY, memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(DEFAULT_TOOLS), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(helperOf(sources, tools), (helper) =>
        Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, parts.watchMemory(memory), tools, toolsLive, helper)), (main) =>
          // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
          programOf(main)))
    })
  })

/** Three messages at once, one turn: two tasks started and a sum, each a call of its own in one step. */
const THREE = ["Start a task: what is 6 * 7?", "Start a task: what is 3 + 4?", "What is 2 + 2?"]

export const backgroundTasks: Lesson = {
  slug: "background-tasks",
  files: [
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    {
      id: "helper", label: "helper.ts", defaultText: DEFAULT_HELPER, documentOf: helperDocumentOf, editableFrom: HELPER_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: HELPER_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "tools", label: "tools.ts", defaultText: "", documentOf: () => toolsDocumentOf(DEFAULT_TOOLS), editableFrom: toolsDocumentOf(DEFAULT_TOOLS).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    { id: "memory", label: "memory.ts", defaultText: "", documentOf: () => memoryDocumentOf(DEFAULT_MEMORY), editableFrom: memoryDocumentOf(DEFAULT_MEMORY).length, formatPrefix: "", sections: [], folded: [], readOnly: true },
  ],
  mainFile: "agent",
  chips: ["In the background, what is 6 * 7?", "What is 2 + 2?", "Cancel task t1.", "Hi, I'm Ana."],
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {},
  experiments: {
    instant: { file: "helper", apply: instant },
    "one-at-a-time": { file: "agent", apply: oneAtATime },
  },
  evaluate: evaluateLesson,
  tasks: true,
}
