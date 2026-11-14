import { Clock, Effect, Layer, Option, Ref, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessageEvent, Core, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Sessions, turnEndedEvent, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { callTool, estimateTokens, hostNote, Memory, messageText, modelAnswer, paired, promptMessage } from "@xandreed/sdk/kernel"
import { run, runStatements } from "../../evaluate.ts"
import type { Lesson, LessonControl, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { readSystem, writeSystem } from "../your-first-agent/config-edit.ts"
import { CHAT } from "../tools/chat.source.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { dropFirst, slowMeter, storeClock, unplugMeter } from "./config-edit.ts"
import { DEFAULT_PLUGIN, PLUGIN_HEADER, PLUGIN_IMPORTS, pluginBodyOf, pluginDocumentOf } from "./plugin.source.ts"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }
const pluginNames = { Clock, Effect, Layer, Ref, assistantMessageEvent, Core, turnEndedEvent, turnStartedEvent, userMessage, estimateTokens, hostNote, Memory, messageText, Chat }

const agentNames = (parts: PageParts, flatMemory: unknown, tools: unknown, toolsLive: unknown, meter: unknown, withClock: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Sessions, userMessage, callTool, Memory, modelAnswer, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, tools, toolsLive, meter, withClock, pane: parts.pane, model: parts.model,
})

const fail = (message: string) => Result.fail(message)

/** memory.ts, tools.ts, plugin.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const { tools, toolsLive } = made as { readonly tools: unknown; readonly toolsLive: unknown }
      if (!Layer.isLayer(toolsLive)) return fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(runStatements("plugin.ts did not run: ", pluginBodyOf(sources.plugin ?? ""), "{ meter, withClock }", pluginNames), (plugins) => {
        const { meter, withClock } = plugins as { readonly meter: unknown; readonly withClock: unknown }
        if (!Layer.isLayer(meter)) return fail("plugin.ts did not run: meter is not a layer. It should be Layer.effectDiscard(…).")
        if (typeof withClock !== "function") return fail("plugin.ts did not run: withClock is not a function. It should take the memory it wraps and return a layer.")
        // The page watches the flat memory, below the wrapper: the Context tab shows what memory returned, and the
        // Prompt column what was sent, with the clock's note as code's.
        const watched = parts.watchMemory(memory as Layer.Layer<Memory>)
        return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, watched, tools, toolsLive, meter, withClock)), (main) =>
          Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."))
      })
    })
  })

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const yourOwnPlugin: Lesson = {
  slug: "your-own-plugin",
  files: [
    {
      id: "plugin", label: "plugin.ts", defaultText: DEFAULT_PLUGIN, documentOf: pluginDocumentOf, editableFrom: PLUGIN_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: PLUGIN_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "agent", label: "agent.ts", defaultText: DEFAULT_AGENT, documentOf, editableFrom: HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    {
      id: "tools", label: "tools.ts", defaultText: DEFAULT_TOOLS, documentOf: toolsDocumentOf, editableFrom: TOOLS_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: TOOLS_IMPORTS.length }) }], folded: ["imports"], readOnly: false,
    },
    { id: "chat", label: "chat.ts", defaultText: "", documentOf: () => CHAT, editableFrom: CHAT.length, formatPrefix: "", sections: [], folded: [], readOnly: true },
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const flatMemory = ",
      sections: [], folded: [], readOnly: false,
    },
  ],
  mainFile: "plugin",
  chips: ["What time is it?", "What is 12 * 3?", "Hi, I'm Ana.", "What did I say earlier?"],
  three: ["Hi, I'm Ana.", "What is 12 * 3?", "What time is it?"],
  fill: ["Hi, I'm Ana.", "What is 2 + 2?", "What time is it?", "Remember to buy milk.", "What did I say earlier?"],
  controls: {
    system: control("agent", readSystem, (source, value) => writeSystem(source, String(value))),
  },
  experiments: {
    "store-clock": { file: "plugin", apply: storeClock },
    "drop-first": { file: "plugin", apply: dropFirst },
    "slow-meter": { file: "plugin", apply: slowMeter },
    "unplug-meter": { file: "agent", apply: unplugMeter },
  },
  evaluate: evaluateLesson,
}
