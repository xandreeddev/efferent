// Lesson 5, "Compaction": the conversation outgrows the model. The base
// program, with a memory that keeps state of its own: over its budget it asks
// the learner's summarizer to fold old turns into a summary, stores it once,
// and starts every later context with it.
import { Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Core, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { callTool, framed, Memory, messageText, modelAnswer, Summarizer, SummaryFailed, summaryMemory } from "@xandreed/sdk/kernel"
import { run, runStatements } from "../../evaluate.ts"
import type { Lesson, LessonControl, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { readSystem, writeSystem } from "../your-first-agent/config-edit.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { brokenCalculator } from "../tools/config-edit.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { EVERY_TURN_BUDGET, failingSummarizer, keepNone, readBudget, writeBudget } from "./config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "./memory.source.ts"
import { DEFAULT_SUMMARIZER, SUMMARIZER_INTRO, summarizerDocumentOf } from "./summarizer.source.ts"

const memoryNames = { summaryMemory }
const summarizerNames = { Effect, Layer, Option, Stream, LanguageModel, Prompt, framed, messageText, Summarizer, SummaryFailed }
const toolsNames = { Effect, Schema, Tool, Toolkit }

const agentNames = (parts: PageParts, memory: unknown, summarizerLive: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  memory, summarizerLive, tools, toolsLive, pane: parts.pane, model: parts.model,
})

/** memory.ts, summarizer.ts, tools.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: memory is not a layer. It should be summaryMemory({ … }).")
    return Result.flatMap(run("summarizer.ts did not run: ", sources.summarizer ?? "", summarizerNames), (summarizer) => {
      if (!Layer.isLayer(summarizer)) return Result.fail("summarizer.ts did not run: summarizerLive is not a layer. It should be Layer.effect(Summarizer, …).")
      return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
        const { tools, toolsLive } = made as { readonly tools: unknown; readonly toolsLive: unknown }
        if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
        const watched = parts.watchMemory(memory as Layer.Layer<Memory, never, Summarizer>)
        const summarizerLive = parts.watchSummarizer(summarizer as Layer.Layer<Summarizer, never, LanguageModel.LanguageModel>)
        return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, watched, summarizerLive, tools, toolsLive)), (main) =>
          // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
          Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : Result.fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."))
      })
    })
  })

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const compaction: Lesson = {
  slug: "compaction",
  files: [
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const memory = ",
      sections: [], folded: [], readOnly: false,
    },
    {
      id: "summarizer", label: "summarizer.ts", defaultText: DEFAULT_SUMMARIZER, documentOf: summarizerDocumentOf, editableFrom: SUMMARIZER_INTRO.length, formatPrefix: "const summarizerLive = ",
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
  ],
  mainFile: "memory",
  chips: ["What is 12 * 3?", "Remember to buy milk.", "What did I say earlier?", "Tell me about fibers."],
  three: ["Remember to buy milk.", "What is 12 * 3?", "What are my notes?"],
  // Five turns at once, one after another: enough to pass the budget and see a compaction.
  fill: ["Tell me about fibers.", "Tell me about scopes.", "Tell me about layers.", "Tell me about streams.", "Tell me about schemas."],
  controls: {
    system: control("agent", readSystem, (source, value) => writeSystem(source, String(value))),
    budget: control("memory", readBudget, (source, value) => writeBudget(source, Number(value))),
  },
  experiments: {
    "every-turn": { file: "memory", apply: (source) => writeBudget(source, EVERY_TURN_BUDGET) },
    "keep-none": { file: "memory", apply: keepNone },
    "failing-summarizer": { file: "summarizer", apply: failingSummarizer },
    "broken-calculator": { file: "tools", apply: brokenCalculator },
  },
  evaluate: evaluateLesson,
}
