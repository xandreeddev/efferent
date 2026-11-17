// Lesson 18, "A memory that connects": what an agent knows can be links
// between things. The base program over lesson 2's calculator and the
// kernel's three tools of the graph (`linkThings` stores a link in the graph
// session, `unlinkThings` says one no longer stands, `followThings` reads one
// thing's links), and the kernel's flat memory wrapped with `withGraph`,
// which adds to each request the links near what the question names, the
// path to them first. The page's Clear context is the next conversation: the
// store, and the graph session in it, stay.
import { Effect, Layer, Option, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Core, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { callTool, flatMemory, graphHandlers, graphTools, knownLinks, linksNote, Memory, modelAnswer, namedIn, near, questionOf, withGraph } from "@xandreed/sdk/kernel"
import { named, programOf, runStatements } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { byDistance, followOnly, hopsOne } from "./config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_HEADER, MEMORY_IMPORTS, memoryBodyOf, memoryDocumentOf } from "./memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"

/**
 * What memory.ts imports. `flatMemory` is the kernel's, watched by the page: the wrapper the file makes goes over
 * it, so the Context tab's Memory column shows what the flat memory gave, and its Prompt column shows the note of
 * links the wrapper added after it as the code's, never as something the user said.
 */
const memoryNames = (parts: PageParts) => ({ Effect, Layer, Option, Sessions, flatMemory: parts.watchMemory(flatMemory), knownLinks, linksNote, Memory, namedIn, near, questionOf, withGraph })
const toolsNames = { Effect, Schema, Tool, Toolkit, graphTools }

const agentNames = (parts: PageParts, memory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, graphHandlers, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  memory, tools, toolsLive, pane: parts.pane, model: parts.model,
})

/** Whether a value is a toolkit as agent.ts reads one: it is yielded for its handlers, and it holds its tools by name. */
const isToolkit = (value: unknown): boolean => Effect.isEffect(value) && Predicate.hasProperty(value, "tools") && Predicate.isObject(value.tools)

/** memory.ts, tools.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  // memory.ts is statements: the wrapper is made as the file runs, so options `withGraph` refuses are refused here, as the build.
  Result.flatMap(runStatements("memory.ts did not run: ", memoryBodyOf(sources.memory ?? ""), "memory", memoryNames(parts)), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: memory is not a layer. It should be withGraph({ hops, limit, speaker })(flatMemory).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!isToolkit(tools)) return Result.fail("tools.ts did not run: tools is not a toolkit. It should be Toolkit.merge(Toolkit.make(calculator), graphTools).")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be Toolkit.make(calculator).toLayer({ … }).")
      // The memory is handed on as the file made it: the page watches the flat memory under the wrapper, not the wrapper.
      return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, memory, tools, toolsLive)), (main) =>
        // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
        programOf(main))
    })
  })

/** The seven links of the page's main path, in one message: Echo makes seven calls in one answer. */
export const SEVEN = "Ana works at Acme. Acme is in Lisbon. Ana lives in Porto. Ana likes tea. Bo works at Globex. Ana is the sister of Eva. Ana drives a red car."

/** The question the page asks of them: it names Ana, and the city is two links away. */
export const QUESTION = "In what city does Ana work?"

/** Two links and a sum, which one turn takes together: three calls in one step, then one answer. */
const THREE = ["Ana works at Acme.", "Acme is in Lisbon.", "What is 2 + 3?"]

export const connectedMemory: Lesson = {
  slug: "connected-memory",
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
  chips: [SEVEN, QUESTION, "Acme sells paint.", "What is Acme linked to?", "Unlink e8.", "I work at Acme.", "Where do I work?"],
  // Sent at once, one turn takes all three: two links stored and a sum worked out in one step.
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {},
  experiments: {
    "hops-one": { file: "memory", apply: hopsOne },
    "by-distance": { file: "memory", apply: byDistance },
    "follow-only": { file: "memory", apply: followOnly },
  },
  evaluate: evaluateLesson,
}
