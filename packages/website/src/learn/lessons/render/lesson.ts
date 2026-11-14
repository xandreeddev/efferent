// Lesson 6, "Render": an agent shows things, not only text. Lesson 2's
// program, whose loop runs each call in its turn, and a `show` tool that
// stores a view (a record tagged ui) the chat draws and the model never sees.
import { Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, CONVERSATION_VOCABULARY, Core, messageOf, vocabularyOf, readJournal, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { CurrentTurn, Memory, paired, progressEvent, promptMessage, showView, ViewData, ViewId } from "@xandreed/sdk/kernel"
import { run, runStatements } from "../../evaluate.ts"
import type { Lesson, LessonControl, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { readSystem, writeSystem } from "../your-first-agent/config-edit.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { noTurn, slowShow, tableAsResult } from "./config-edit.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit, CurrentTurn, progressEvent, showView, ViewData, ViewId }

const agentNames = (parts: PageParts, flatMemory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Option, Stream, LanguageModel, Prompt,
  assistantMessage, Core, Sessions, toolResult, turnStartedEvent, userMessage, Memory, CurrentTurn, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, tools, toolsLive, pane: parts.pane, model: parts.model,
})

/** memory.ts, tools.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const { tools, toolsLive } = made as { readonly tools: unknown; readonly toolsLive: unknown }
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, parts.watchMemory(memory as Layer.Layer<Memory>), tools, toolsLive)), (main) =>
        Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : Result.fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."))
    })
  })

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const render: Lesson = {
  slug: "render",
  files: [
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const flatMemory = ",
      sections: [], folded: [], readOnly: false,
    },
  ],
  mainFile: "tools",
  chips: ["Show a table of squares to 5.", "Show a table of squares to 8.", "Show the times table of 7.", "What is 12 * 3?"],
  three: ["Show a table of squares to 4.", "Show a table of cubes to 4.", "What is 6 * 7?"],
  fill: ["Show a table of squares to 3.", "Show a table of cubes to 3.", "Show the times table of 3.", "What is 2 + 2?", "Hello."],
  controls: {
    system: control("agent", readSystem, (source, value) => writeSystem(source, String(value))),
  },
  experiments: {
    "slow-show": { file: "tools", apply: slowShow },
    "table-as-result": { file: "tools", apply: tableAsResult },
    "no-turn": { file: "agent", apply: noTurn },
  },
  evaluate: evaluateLesson,
}
