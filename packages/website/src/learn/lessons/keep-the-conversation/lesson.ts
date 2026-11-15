// Lesson 7, "Keep the conversation": the store is a module like any other.
// The learner writes one over the browser's localStorage, the chat finds the
// last conversation again when the page loads and closes a turn the page
// before it left open, and everything stored is drawn again from the journal.
import { Array as Arr, Clock, Context, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import {
  byCreation, CONVERSATION_VOCABULARY, Core, currentFormat, JournalStorage, JournalStorageError, journalStorageConformance, messageOf,
  readJournal, Seq, SessionHeader, Sessions, StoredEvent, turnStartedEvent, userMessage, vocabularyOf,
} from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { callTool, Memory, modelAnswer, paired, promptMessage } from "@xandreed/sdk/kernel"
import type { KeyValueStore } from "@xandreed/sdk/kernel"
import { programOf, run, runStatements } from "../../evaluate.ts"
import type { Lesson, LessonControl, LessonKit, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { readSystem, writeSystem } from "../your-first-agent/config-edit.ts"
import { slowCalculator } from "../tools/config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CHAT_INTRO, chatDocumentOf, DEFAULT_RESUME } from "./chat.source.ts"
import { forgetsEvents, noPlaceCheck, noRecover } from "./config-edit.ts"
import { DEFAULT_STORE, STORE_HEADER, STORE_IMPORTS, storeBodyOf, storeDocumentOf } from "./store.source.ts"

/** The key prefix the lesson's journals live under in the browser's storage, which every page of the site shares. */
export const STORAGE_PREFIX = "efferent-learn:keep-the-conversation:"

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }
const storeNames = { Arr, Clock, Effect, Layer, Schema, byCreation, JournalStorage, JournalStorageError, Seq, SessionHeader, StoredEvent }
const resumeNames = { Effect, Result, currentFormat, Sessions }

type Store = (storage: KeyValueStore, options: { readonly prefix: string }) => Layer.Layer<JournalStorage>

const agentNames = (parts: PageParts, store: Store, resume: Effect.Effect<SessionId, { readonly message: string }, Sessions>, flatMemory: unknown, tools: unknown, toolsLive: unknown) => ({
  Effect, Stream, LanguageModel, Prompt,
  Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, Chat,
  kernel: parts.kernel, sessions: parts.sessions,
  // The learner's store, built as written; the page's base goes through it from then on.
  store: (storage: KeyValueStore, options: { readonly prefix: string }) => parts.storeOn(store(storage, options)),
  // The browser's storage, seen through this lesson's prefix: every page of the site shares the real one.
  localStorage: parts.storage,
  // The chat is the page's, and the conversation it shows is the one the learner's `resume` gives.
  chatOn: () => parts.chatWith(resume),
  flatMemory, tools, toolsLive, pane: parts.pane, model: parts.model,
})

/** store.ts as the page runs it: the learner's `store`, or why it did not run. */
const storeOf = (sources: Sources): Result.Result<Store, string> =>
  Result.flatMap(runStatements("store.ts did not run: ", storeBodyOf(sources.store ?? ""), "store", storeNames), (store) =>
    typeof store === "function" ? Result.succeed(store as Store) : Result.fail("store.ts did not run: store is not a function. It should take the storage and its options, and give a layer."))

/** memory.ts, tools.ts, store.ts, chat.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const { tools, toolsLive } = made as { readonly tools: unknown; readonly toolsLive: unknown }
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(storeOf(sources), (store) =>
        Result.flatMap(run("chat.ts did not run: ", sources.chat ?? "", resumeNames), (resume) => {
          if (!Effect.isEffect(resume)) return Result.fail("chat.ts did not run: resume is not an Effect. It should give the conversation to go on with.")
          const names = agentNames(parts, store, resume as Effect.Effect<SessionId, { readonly message: string }, Sessions>, parts.watchMemory(memory as Layer.Layer<Memory>), tools, toolsLive)
          return Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", names), (main) =>
            programOf(main))
        }))
    })
  })

/** The storage kit over the learner's store: an empty storage per check, and two handles on one storage for the check of a reopening. */
const storeKit: LessonKit = (sources, storageOf) =>
  Result.map(storeOf(sources), (store) => {
    const over = (storage: KeyValueStore) => Effect.map(Effect.orDie(Layer.build(store(storage, { prefix: "kit:" }))), (built) => Context.get(built, JournalStorage))
    return journalStorageConformance({
      open: Effect.suspend(() => over(storageOf())),
      pair: Effect.suspend(() => { const storage = storageOf(); return Effect.all([over(storage), over(storage)], { concurrency: 1 }) }),
    })
  })

const control = (file: string, read: LessonControl["read"], write: LessonControl["write"]): LessonControl => ({ file, read, write })

export const keepTheConversation: Lesson = {
  slug: "keep-the-conversation",
  files: [
    {
      id: "store", label: "store.ts", defaultText: DEFAULT_STORE, documentOf: storeDocumentOf, editableFrom: STORE_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: STORE_IMPORTS.length }) }], folded: [], readOnly: false,
    },
    {
      id: "chat", label: "chat.ts", defaultText: DEFAULT_RESUME, documentOf: chatDocumentOf, editableFrom: CHAT_INTRO.length, formatPrefix: "export const resume = ",
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
    {
      id: "memory", label: "memory.ts", defaultText: DEFAULT_MEMORY, documentOf: memoryDocumentOf, editableFrom: MEMORY_INTRO.length, formatPrefix: "const flatMemory = ",
      sections: [], folded: [], readOnly: false,
    },
  ],
  mainFile: "store",
  chips: ["My name is Ana.", "What did I say earlier?", "What is 12 * 3?", "Remember to buy milk."],
  three: ["My name is Ana.", "What is 12 * 3?", "What did I say earlier?"],
  fill: ["Tell me about fibers.", "Tell me about scopes.", "Tell me about layers.", "Tell me about streams.", "Tell me about schemas."],
  controls: {
    system: control("agent", readSystem, (source, value) => writeSystem(source, String(value))),
  },
  experiments: {
    "slow-calculator": { file: "tools", apply: slowCalculator },
    "no-recover": { file: "chat", apply: noRecover },
    "no-place-check": { file: "store", apply: noPlaceCheck },
    "forgets-events": { file: "store", apply: forgetsEvents },
  },
  evaluate: evaluateLesson,
  durable: { prefix: STORAGE_PREFIX },
  kits: { store: storeKit },
}
