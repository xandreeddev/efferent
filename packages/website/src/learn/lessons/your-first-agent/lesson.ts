// Lesson 1, "Your first agent": the learner's program (agent.ts) is the
// loop. It takes each message from the chat (chat.ts, read-only), opens a
// turn, stores the message, asks memory (memory.ts, theirs to write) for the
// context, calls the model and stores the answer.
import { Effect, Layer, Option, Result, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { assistantMessage, Core, CONVERSATION_READER, messageOf, readerFor, readJournal, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { Memory, promptMessage } from "@xandreed/sdk/kernel"
import { runStatements, run } from "../../evaluate.ts"
import type { Lesson, LessonControl, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CHAT } from "./chat.source.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "./memory.source.ts"
import { readLastN, readSystem, shouting, withoutMemory, withReminder, writeLastN, writeSystem } from "./config-edit.ts"

/** The names memory.ts imports: all its code may use. */
const memoryNames = { Effect, Layer, Option, CONVERSATION_READER, messageOf, readerFor, readJournal, Memory, promptMessage }

/** The names agent.ts imports, with the page's stand-ins for the modules it is given, and `pane` and `model`. */
const agentNames = (parts: PageParts, flatMemory: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  assistantMessage, Core, Sessions, turnStartedEvent, userMessage, Memory, Chat,
  kernel: parts.kernel, inProcessJournal: parts.inProcessJournal, sessions: parts.sessions, chatOn: parts.chatOn,
  flatMemory, pane: parts.pane, model: parts.model,
})

/** memory.ts and then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) =>
    Layer.isLayer(memory)
      ? Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", agentNames(parts, parts.watchMemory(memory as Layer.Layer<Memory>))), (main) =>
        // The learner's code is untyped JavaScript: what main needs is checked when it runs, a missing module as a defect the page reports.
        Effect.isEffect(main) ? Result.succeed(main as Effect.Effect<unknown, unknown>) : Result.fail("agent.ts did not run: main is not an Effect. It should be the program, given its modules with Effect.provide."))
      : Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …)."))

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const yourFirstAgent: Lesson = {
  slug: "your-first-agent",
  files: [
    {
      id: "agent",
      label: "agent.ts",
      defaultText: DEFAULT_AGENT,
      documentOf,
      editableFrom: HEADER.length,
      formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: IMPORTS.length }) }],
      folded: ["imports"],
      readOnly: false,
    },
    {
      id: "chat",
      label: "chat.ts",
      defaultText: "",
      documentOf: () => CHAT,
      editableFrom: CHAT.length,
      formatPrefix: "",
      sections: [],
      folded: [],
      readOnly: true,
    },
    {
      id: "memory",
      label: "memory.ts",
      defaultText: DEFAULT_MEMORY,
      documentOf: memoryDocumentOf,
      editableFrom: MEMORY_INTRO.length,
      formatPrefix: "const flatMemory = ",
      sections: [],
      folded: [],
      readOnly: false,
    },
  ],
  mainFile: "agent",
  chips: ["Tell me about loops", "What did I just say?", "What is in your context?"],
  // The second and third turns can only answer from the turns before them.
  three: ["My name is Ana.", "What did I just say?", "What is in your context?"],
  fill: ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4", "tell me about topic 5"],
  controls: {
    system: control("agent", readSystem, (source, value) => writeSystem(source, String(value))),
    lastN: control("memory", readLastN, (source, value) => writeLastN(source, Number(value))),
  },
  experiments: {
    pirate: { file: "agent", apply: (source) => writeSystem(source, "You are a pirate. Answer in at most two short sentences, and always say arr.") },
    reminder: { file: "agent", apply: withReminder },
    shout: { file: "agent", apply: shouting },
    "last-two": { file: "memory", apply: (source) => writeLastN(source, 2) },
    "no-memory": { file: "agent", apply: withoutMemory },
  },
  evaluate: evaluateLesson,
}
