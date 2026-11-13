// Lesson 2, "Tools": the learner's turn becomes a loop over steps. The
// model answers, or asks for tools (tools.ts, theirs to write); the turn
// runs each call, stores its result and asks again, and takes the messages
// sent while it works between steps.
import { Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, Core, CONVERSATION_READER, messageOf, readerFor, readJournal, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { Memory, paired, promptMessage } from "@xandreed/sdk/kernel"
import { run, runStatements } from "../../evaluate.ts"
import type { Lesson, LessonControl, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { readSystem, writeSystem } from "../your-first-agent/config-edit.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CHAT } from "./chat.source.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "./memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"
import { brokenCalculator, readMaxSteps, slowCalculator, withoutSteering, writeMaxSteps } from "./config-edit.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_READER, messageOf, readerFor, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }

const agentNames = (parts: PageParts, flatMemory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Option, Stream, LanguageModel, Prompt,
  assistantMessage, Core, Sessions, toolResult, turnStartedEvent, userMessage, Memory, Chat,
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
        // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
        Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : Result.fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."))
    })
  })

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const tools: Lesson = {
  slug: "tools",
  files: [
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
  mainFile: "agent",
  chips: ["What is 12 * 3?", "Remember to buy milk.", "What are my notes?", "What is 1 / 0?"],
  // Sent at once: the second and third arrive while the first turn runs its tool, and join it.
  three: ["Remember to buy milk.", "What is 12 * 3?", "What are my notes?"],
  fill: ["What is 2 + 2?", "What is 10 / 4?", "Remember the answer is 2.5.", "What are my notes?", "What is 7 * 6?"],
  controls: {
    system: control("agent", readSystem, (source, value) => writeSystem(source, String(value))),
    maxSteps: control("agent", readMaxSteps, (source, value) => writeMaxSteps(source, Number(value))),
  },
  experiments: {
    "broken-calculator": { file: "tools", apply: brokenCalculator },
    "slow-calculator": { file: "tools", apply: slowCalculator },
    "one-step": { file: "agent", apply: (source) => writeMaxSteps(source, 1) },
    "no-steering": { file: "agent", apply: withoutSteering },
  },
  evaluate: evaluateLesson,
}
