// Lesson 18, "A memory that keeps itself": a curator, outside the agent,
// keeps the memory after each turn, and each request is sent what is stored
// about what the conversation names. The base program over lesson 2's
// calculator alone, with no tool that remembers; curator.ts's `keep`, which
// agent.ts runs after each turn's answer (the kernel's curation step over the
// page's curator model); and the kernel's flat memory wrapped with
// `withKnowledge`, which chooses by the conversation's words, with no model
// and nothing embedded. The page's Clear context is the next conversation:
// the store, and the knowledge session in it, stay. Load the world writes 654
// sentences into the knowledge session (load-world.ts); the controls edit the
// `limit` and `walk` of memory.ts's one call.
import { Clock, Effect, Layer, Option, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Core, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { callTool, curate, curateAgain, CurationFailed, Curator, flatMemory, knowledgeOf, knowledgeSession, Memory, modelAnswer, turnSource, turnsOf, withKnowledge } from "@xandreed/sdk/kernel"
import { named, programOf, runStatements } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CONTROLS, reviewOff, walkZero } from "./config-edit.ts"
import { CURATOR_HEADER, CURATOR_IMPORTS, curatorBodyOf, curatorDocumentOf, DEFAULT_CURATOR } from "./curator.source.ts"
import { loadWorld } from "./load-world.ts"
import { DEFAULT_MEMORY, MEMORY_HEADER, MEMORY_IMPORTS, memoryBodyOf, memoryDocumentOf } from "./memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"

/**
 * What memory.ts imports. `flatMemory` is the kernel's, watched by the page: the wrapper the file makes goes over
 * it, so the Context tab's Memory column shows what the flat memory gave, and its Prompt column shows the note of
 * memories the wrapper added after it as the code's, never as something the user said.
 */
const memoryNames = (parts: PageParts) => ({ flatMemory: parts.watchMemory(flatMemory), withKnowledge })
const toolsNames = { Effect, Schema, Tool, Toolkit }
const curatorNames = { Clock, Effect, Layer, Option, Stream, LanguageModel, Sessions, curate, curateAgain, CurationFailed, Curator, knowledgeOf, knowledgeSession, turnSource, turnsOf, Chat }

const agentNames = (parts: PageParts, memory: unknown, tools: unknown, toolsLive: unknown, curatorOn: unknown, keep: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  memory, tools, toolsLive, curatorOn, keep, pane: parts.pane, model: parts.model, curatorModel: parts.curatorModel,
})

/** Whether a value is a toolkit as agent.ts reads one: it is yielded for its handlers, and it holds its tools by name. */
const isToolkit = (value: unknown): boolean => Effect.isEffect(value) && Predicate.hasProperty(value, "tools") && Predicate.isObject(value.tools)

/**
 * curator.ts as the page runs it: its curator, made over the curator's model once here, so one that makes no layer
 * refuses the build in words that name the file; and `keep`. agent.ts is handed a `curatorOn` that gives the
 * learner's curator watched by the page, so its model calls are filed as the curator's.
 */
const curatorOf = (sources: Sources, parts: PageParts): Result.Result<{ readonly curatorOn: (model: unknown) => unknown; readonly keep: unknown }, string> =>
  Result.flatMap(runStatements("curator.ts did not run: ", curatorBodyOf(sources.curator ?? ""), "{ curatorOn, keep }", curatorNames), (made) => {
    const curatorOn = named(made, "curatorOn")
    const keep = named(made, "keep")
    if (typeof curatorOn !== "function") return Result.fail("curator.ts did not run: curatorOn is not a function. It should be (model) => Layer.effect(Curator, …).pipe(Layer.provide(model)).")
    const checked = Reflect.apply(curatorOn, undefined, [parts.curatorModel])
    if (!Layer.isLayer(checked)) return Result.fail("curator.ts did not run: curatorOn(model) is not a layer. It should be Layer.effect(Curator, …).pipe(Layer.provide(model)).")
    if (!Effect.isEffect(keep)) return Result.fail("curator.ts did not run: keep is not an Effect. It should be Effect.gen(function* () { … }).")
    return Result.succeed({
      curatorOn: (model: unknown) => {
        const layer = Reflect.apply(curatorOn, undefined, [model])
        return Layer.isLayer(layer) ? parts.watchCurator(layer) : layer
      },
      keep,
    })
  })

/** memory.ts, tools.ts, curator.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  // memory.ts is statements: the wrapper is made as the file runs, so options `withKnowledge` refuses are refused here, as the build.
  Result.flatMap(runStatements("memory.ts did not run: ", memoryBodyOf(sources.memory ?? ""), "memory", memoryNames(parts)), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: memory is not a layer. It should be withKnowledge({ limit, walk, speaker, stopWords })(flatMemory).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!isToolkit(tools)) return Result.fail("tools.ts did not run: tools is not a toolkit. It should be Toolkit.make(calculator).")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(curatorOf(sources, parts), ({ curatorOn, keep }) =>
        // The memory is handed on as the file made it: the page watches the flat memory under the wrapper, not the wrapper.
        Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, memory, tools, toolsLive, curatorOn, keep)), (main) =>
          // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
          programOf(main)))
    })
  })

/** Step 3's message: two memories, about Ana Silva, Acme and Lisbon. */
export const ANA = "My friend Ana Silva works at Acme. Acme is in Lisbon."

/** Step 4's question: it names Ana Silva, and the city is reached by the walk by subject, from Acme. */
export const QUESTION = "In what city does Ana Silva work?"

/** Step 5's change: the old memory is ended, not deleted. */
export const CHANGE = "Ana Silva now works at Globex."

/** Step 6's: the speaker's words. */
export const HOME = "I live in Porto."
export const WHERE_I_LIVE = "Where do I live?"

/** The questions of the world's steps, each asked of the world once it is loaded. */
export const ORCHID = "Where does the person who leads Project Orchid live?"
export const EMPLOYS = "Who employs Ana Silva?"

/** Two messages and a sum, which one turn takes together: one step with a call, then one answer. */
const THREE = ["My friend Ana Silva works at Acme.", "Acme is in Lisbon.", "What is 2 + 3?"]

export const connectedMemory: Lesson = {
  slug: "connected-memory",
  files: [
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: MEMORY_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "curator", label: "curator.ts", defaultText: DEFAULT_CURATOR, documentOf: curatorDocumentOf, editableFrom: CURATOR_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: CURATOR_IMPORTS.length }) }], folded: ["imports"], readOnly: false,
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
  ],
  mainFile: "memory",
  chips: [ANA, QUESTION, CHANGE, "Where does Ana Silva work now?", HOME, WHERE_I_LIVE, ORCHID, EMPLOYS],
  // Sent at once, one turn takes all three: a sum worked out, and what the turn said kept once it is answered.
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  // limit and walk: each writes one option of memory.ts's withKnowledge call.
  controls: CONTROLS,
  experiments: {
    "walk-zero": { file: "memory", apply: walkZero },
    "review-off": { file: "curator", apply: reviewOff },
  },
  evaluate: evaluateLesson,
  // The Graph tab, and the world "Load the world" writes into the knowledge session.
  graph: { load: loadWorld },
}
