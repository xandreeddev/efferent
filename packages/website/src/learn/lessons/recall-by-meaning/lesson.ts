// Lesson 20, "Recall by meaning": lesson 18's memory with a third list. The
// program is lesson 18's (curator.ts, tools.ts and agent.ts's loop), and
// memory.ts wraps the flat memory with the kernel's `withKnowledgeByMeaning`
// in place of `withKnowledge`: the memories about what the message names,
// those its words reach, and those nearest it in meaning, put in one order.
// The page gives the embedder, e5-small-v2 in a worker, loaded by "Load the
// embedder", and a store of vectors, both built once per runtime: before the
// embedder is loaded the kernel skips its list by meaning and recall runs by
// words alone, and the status line says so. Load the world writes lesson 18's
// world, and puts the vectors made ahead for its memories in the store first,
// so a request embeds only its message.
import { Effect, Layer } from "effect"
import { Sessions } from "@xandreed/core/kernel"
import { flatMemory, withKnowledgeByMeaning } from "@xandreed/sdk/kernel"
import type { VectorStore } from "@xandreed/sdk/kernel"
import type { Lesson, PageParts } from "../../lesson.ts"
import type { EmbedderService } from "../../models/meaning.ts"
import { Chat } from "../../page-chat.ts"
import { CHAT } from "../tools/chat.source.ts"
import { CURATOR_HEADER, CURATOR_IMPORTS, curatorDocumentOf, DEFAULT_CURATOR } from "../connected-memory/curator.source.ts"
import { agentNames as wordsAgentNames, BIRD, BY_RULE, evaluateKnowledge, isCurationLine, ORCHID } from "../connected-memory/lesson.ts"
import { loadWorld } from "../connected-memory/load-world.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsDocumentOf } from "../connected-memory/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { CONTROLS, floorOn, meaningOff, wordsOff } from "./config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_HEADER, MEMORY_IMPORTS, memoryDocumentOf } from "./memory.source.ts"
import { EMBEDDER_MODEL } from "./model.ts"

export { BIRD, ORCHID }

/** What the status line adds to a curation's line while the embedder is not loaded: that turn's recall used words alone. */
export const WORDS_ALONE = "The embedder is not loaded: recall used words alone."

/** Step 5's question: it names Rui Reis, and by meaning alone another Reis's dog comes first. */
export const PET = "What pet does Rui Reis have?"

/** Step 6's question: it names nobody and shares no word with "Bruno Reis lives in Madrid.", which ended when he moved. */
export const CAPITAL = "Who once called the Spanish capital home?"

/** Step 7's message: a greeting, which asks for nothing a memory holds. */
export const THANKS = "Thanks!"

/** Two messages and a sum, which one turn takes together: one step with a call, then one answer (lesson 18's). */
const THREE = ["My friend Ana Silva works at Acme.", "Acme is in Lisbon.", "What is 2 + 3?"]

/**
 * What memory.ts imports. `flatMemory` is the kernel's, watched by the page: the wrapper the file makes goes over it,
 * so the Context tab's Memory column shows what the flat memory gave, and its Prompt column shows the note of memories
 * the wrapper added after it as the code's.
 */
const memoryNames = (parts: PageParts) => ({ flatMemory: parts.watchMemory(flatMemory), withKnowledgeByMeaning })

/**
 * The chat agent.ts is handed: the page's, whose status line, after a curation's line ("Curated turn 2: …"), says who
 * curated when the page's Echo curated in place of the model picked (lesson 18's), and that the turn's recall used
 * words alone while the embedder is not loaded.
 */
const chatFor = (parts: PageParts) => (pane: unknown): Layer.Layer<Chat, never, Sessions> =>
  Layer.effect(Chat, Effect.map(Effect.gen(function* () { return yield* Chat }), (chat) => Chat.of({
    ...chat,
    status: (text) => {
      if (!isCurationLine(text)) return chat.status(text)
      const unloaded = parts.meaning._tag === "Some" && !parts.meaning.value.loaded()
      return chat.status([text, ...(parts.curatesByRule ? [BY_RULE] : []), ...(unloaded ? [WORDS_ALONE] : [])].join(" "))
    },
  }))).pipe(Layer.provide(parts.chatOn(pane)))

/** What agent.ts is handed: lesson 18's names, this lesson's chat, and the page's embedder and store of vectors. */
const agentNames = (parts: PageParts, memory: unknown, tools: unknown, toolsLive: unknown, curatorOn: unknown, keep: unknown) => ({
  ...wordsAgentNames(parts, memory, tools, toolsLive, curatorOn, keep),
  chatOn: chatFor(parts),
  // Given by the page, as `model` is: none on a page that does not build them, and the program then fails as it starts.
  embedder: parts.meaning._tag === "Some" ? parts.meaning.value.embedder : Layer.empty,
  vectors: parts.meaning._tag === "Some" ? parts.meaning.value.vectors : Layer.empty,
})

/** memory.ts, tools.ts, curator.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = evaluateKnowledge({
  memoryNames,
  memoryShould: "withKnowledgeByMeaning({ limit, walk, pool, weights, speaker, stopWords })(flatMemory)",
  agentNames,
})

/**
 * The vectors made ahead for the world's memories, into the page's store (ship.ts): imported only now, with their
 * codec, so no page carries them before Load the world is pressed. What was put, in words, or why nothing was.
 */
export const shipVectors: Effect.Effect<string, string, VectorStore> = Effect.flatMap(
  Effect.tryPromise({ try: () => import("./ship.ts"), catch: () => "the world's vectors could not be loaded. Reload the page to try again." }),
  (ship) => ship.shipVectors,
)

/** The page's embedder, its module imported only when "Load the embedder" is pressed: no page carries it before. */
const loadEmbedder = (onProgress: (text: string) => void): Promise<EmbedderService> =>
  import("../../models/meaning.ts").then((meaning) => meaning.loadEmbedder(onProgress))

export const recallByMeaning: Lesson = {
  slug: "recall-by-meaning",
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
  chips: [BIRD, ORCHID, PET, CAPITAL, THANKS],
  three: THREE,
  fill: THREE,
  // limit, walk, pool and the meaning list's weight: each writes one line of memory.ts's call, or one number of it.
  controls: CONTROLS,
  experiments: {
    "meaning-off": { file: "memory", apply: meaningOff },
    "words-off": { file: "memory", apply: wordsOff },
    floor: { file: "memory", apply: floorOn },
  },
  evaluate: evaluateLesson,
  // The Graph tab, and lesson 18's world "Load the world" writes into the knowledge session.
  graph: { load: loadWorld },
  // The embedder "Load the embedder" loads, and the vectors made ahead for the world.
  meaning: { model: EMBEDDER_MODEL, embedder: loadEmbedder, ship: shipVectors },
}
