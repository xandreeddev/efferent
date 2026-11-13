import { Context, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, CONVERSATION_READER, messageOf, readerFor, readJournal, Sessions, toolResult, userMessage } from "@xandreed/core/kernel"
import { Memory, paired, promptMessage } from "@xandreed/sdk/kernel"
import { run, runStatements } from "../../evaluate.ts"
import type { Lesson, LessonControl, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { readSystem, writeSystem } from "../your-first-agent/config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CHAT } from "./chat.source.ts"
import { noDelegate, sameSession, slowHelper } from "./config-edit.ts"
import { DEFAULT_LOOP, LOOP_HEADER, LOOP_IMPORTS, loopBodyOf, loopDocumentOf } from "./loop.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "./tools.source.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_READER, messageOf, readerFor, readJournal, Memory, paired, promptMessage }
const loopNames = { Effect, Option, Stream, LanguageModel, Prompt, assistantMessage, toolResult, userMessage, Memory }
const toolsNames = { Context, Effect, Schema, Tool, Toolkit }

const fail = (message: string) => Result.fail(message)

/** memory.ts, loop.ts, tools.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("loop.ts did not run: ", loopBodyOf(sources.loop ?? ""), "runAgent", loopNames), (runAgent) => {
      if (typeof runAgent !== "function") return fail("loop.ts did not run: runAgent is not a function. It should take an agent and return its turn.")
      return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ Helper, helperTools, tools, helperToolsLive, delegateLive }", toolsNames), (made) => {
        const tools = made as Record<string, unknown>
        if (!Layer.isLayer(tools.helperToolsLive) || !Layer.isLayer(tools.delegateLive)) return fail("tools.ts did not run: helperToolsLive and delegateLive should be layers, made with toLayer.")
        const names = {
          Effect, Layer, Stream, Sessions, Chat, runAgent, ...tools,
          kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
          flatMemory: parts.watchMemory(memory as Layer.Layer<Memory>), pane: parts.pane, model: parts.model,
        }
        return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", names), (main) =>
          Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."))
      })
    })
  })

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const subAgents: Lesson = {
  slug: "sub-agents",
  files: [
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "loop", label: "loop.ts", defaultText: DEFAULT_LOOP, documentOf: loopDocumentOf, editableFrom: LOOP_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: LOOP_IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const flatMemory = ",
      sections: [], folded: [], readOnly: false,
    },
  ],
  mainFile: "agent",
  chips: ["Ask a helper: what is 6 * 7?", "Have a helper work out 120 / 8.", "What is 2 + 2?", "Hi, I'm Ana."],
  three: ["Hi, I'm Ana.", "Ask a helper: what is 6 * 7?", "What did I say earlier?"],
  fill: ["Hi, I'm Ana.", "Ask a helper: what is 6 * 7?", "Have a helper work out 120 / 8.", "What did I say earlier?"],
  controls: {
    system: control("agent", readSystem, (source, value) => writeSystem(source, String(value))),
  },
  experiments: {
    "same-session": { file: "agent", apply: sameSession },
    "slow-helper": { file: "tools", apply: slowHelper },
    "no-delegate": { file: "agent", apply: noDelegate },
  },
  evaluate: evaluateLesson,
}
