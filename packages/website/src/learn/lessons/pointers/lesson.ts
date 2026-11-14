// Lesson 8, "Pointers": a tool's long answer stays whole in the journal.
// The base program, over lesson 2's flat memory with one function changed
// (`pointed` in place of `messageOf`): the model is sent the start of a long
// result and a pointer, and reads on with the kernel's `ReadResult`.
import { Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { CONVERSATION_VOCABULARY, Core, messageOf, vocabularyOf, readJournal, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { callTool, Memory, modelAnswer, paired, pointed, promptMessage, ReadResult, readResult } from "@xandreed/sdk/kernel"
import { runStatements } from "../../evaluate.ts"
import type { Lesson, LessonControl, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { noPointers, noReadResult, olderTurns, readOver, readPreview, TINY_PREVIEW, writeOver, writePreview } from "./config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_HEADER, MEMORY_IMPORTS, memoryBodyOf, memoryDocumentOf } from "./memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, pointed, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit, ReadResult, readResult }

const agentNames = (parts: PageParts, flatMemory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, tools, toolsLive, pane: parts.pane, model: parts.model,
})

/** memory.ts, tools.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  // memory.ts is statements: the rule is made as the file runs, so numbers `pointed` refuses are refused here, as the build.
  Result.flatMap(runStatements("memory.ts did not run: ", memoryBodyOf(sources.memory ?? ""), "flatMemory", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const { tools, toolsLive } = made as { readonly tools: unknown; readonly toolsLive: unknown }
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, parts.watchMemory(memory as Layer.Layer<Memory>), tools, toolsLive)), (main) =>
        // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
        Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : Result.fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."))
    })
  })

/** The three lookups "Send three at once" sends. */
const THREE = ["Look up tides.", "Look up volcanoes.", "Look up honeybees."]

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const pointers: Lesson = {
  slug: "pointers",
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
  chips: ["Look up tides.", "Read more.", "Tell me about volcanoes.", "Look up honeybees."],
  // Sent at once, one turn takes all three and looks each article up in one step.
  three: THREE,
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: THREE,
  controls: {
    over: control("memory", readOver, (source, value) => writeOver(source, Number(value))),
    preview: control("memory", readPreview, (source, value) => writePreview(source, Number(value))),
  },
  experiments: {
    "no-pointers": { file: "memory", apply: noPointers },
    "older-turns": { file: "memory", apply: olderTurns },
    "tiny-preview": { file: "memory", apply: (source) => writePreview(source, TINY_PREVIEW) },
    "no-read-result": { file: "tools", apply: noReadResult },
  },
  evaluate: evaluateLesson,
}
