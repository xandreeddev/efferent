// Lesson 11, "Remember across sessions": what an agent knows between
// conversations is a journal of its own. The base program over lesson 2's
// calculator and the kernel's two tools that remember (`rememberFact` writes
// a fact to the memory session, `forgetFact` says one no longer stands), and
// the kernel's flat memory wrapped with `withFacts`, which adds the facts
// that stand to each request. The page's Clear context is the next
// conversation: the store, and the memory session in it, stay.
import { Effect, Layer, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Core, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { callTool, factHandlers, factsNote, factTools, flatMemory, Memory, modelAnswer, questionOf, relevant, rememberedFacts, withFacts } from "@xandreed/sdk/kernel"
import { named, programOf, runStatements } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { factsFirst, limitOne, withoutWrapper, withRecallTool } from "./config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_HEADER, MEMORY_IMPORTS, memoryBodyOf, memoryDocumentOf } from "./memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"

/**
 * What memory.ts imports. `flatMemory` is the kernel's, watched by the page: the wrapper the file makes goes over
 * it, so the Context tab's Memory column shows what the flat memory gave, and its Prompt column shows what the
 * wrapper added after it as the code's, never as something the user said (lesson 3 places its clock the same way).
 */
const memoryNames = (parts: PageParts) => ({ Effect, Layer, Sessions, factsNote, flatMemory: parts.watchMemory(flatMemory), Memory, questionOf, relevant, rememberedFacts, withFacts })
const toolsNames = { Effect, Schema, Tool, Toolkit, Sessions, factTools, rememberedFacts }

const agentNames = (parts: PageParts, memory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, factHandlers, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  memory, tools, toolsLive, pane: parts.pane, model: parts.model,
})

/** Whether a value is a toolkit as agent.ts reads one: it is yielded for its handlers, and it holds its tools by name. */
const isToolkit = (value: unknown): boolean => Effect.isEffect(value) && Predicate.hasProperty(value, "tools") && Predicate.isObject(value.tools)

/** memory.ts, tools.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  // memory.ts is statements: the wrapper is made as the file runs, so a limit `withFacts` refuses is refused here, as the build.
  Result.flatMap(runStatements("memory.ts did not run: ", memoryBodyOf(sources.memory ?? ""), "memory", memoryNames(parts)), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: memory is not a layer. It should be withFacts({ limit: 5 })(flatMemory).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!isToolkit(tools)) return Result.fail("tools.ts did not run: tools is not a toolkit. It should be Toolkit.merge(Toolkit.make(calculator), factTools).")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be Toolkit.make(calculator).toLayer({ … }).")
      // The memory is handed on as the file made it: the page watches the flat memory under the wrapper, not the wrapper.
      return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, memory, tools, toolsLive)), (main) =>
        // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
        programOf(main))
    })
  })

/** Two facts and a sum, which one turn takes together: three calls in one step, then one answer. */
const THREE = ["My name is Ana.", "I live in Lisbon.", "What is 2 + 3?"]

export const remember: Lesson = {
  slug: "remember",
  files: [
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: MEMORY_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
  ],
  mainFile: "memory",
  chips: ["My name is Ana.", "What is my name?", "I live in Lisbon.", "Forget my name.", "What is 2 + 3?"],
  // Sent at once, one turn takes all three: two facts remembered and a sum worked out in one step.
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {},
  experiments: {
    "recall-tool": { file: "tools", apply: withRecallTool, also: [{ file: "memory", apply: withoutWrapper }] },
    "facts-first": { file: "memory", apply: factsFirst },
    "limit-one": { file: "memory", apply: limitOne },
  },
  evaluate: evaluateLesson,
}
