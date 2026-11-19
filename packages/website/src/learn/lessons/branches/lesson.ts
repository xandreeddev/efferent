// Lesson 15, "Branches": continue a conversation from an earlier turn and keep
// the original. Lesson 7's durable program, with one new file, branch.ts,
// whose `branchFrom` the page calls on its own base sessions when "Branch
// after turn N" is pressed, and lesson 7's chat.ts with a `resume` that shows
// the chat the page asks for (`chosen`) when it is one of the learner's own.
// store.ts is lesson 7's, shown read-only: lesson 7 owns it, and its kit.
import { Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import {
  CONVERSATION_VOCABULARY, Core, currentFormat, messageOf, readJournal, SessionId, Sessions, turnStartedEvent, TurnNumber, userMessage, vocabularyOf,
} from "@xandreed/core"
import { callTool, Memory, modelAnswer, paired, promptMessage } from "@xandreed/sdk"
import type { KeyValueStore } from "@xandreed/sdk"
import { named, programOf, run, runStatements, textOf } from "../../evaluate.ts"
import type { Lesson, PageParts, Sources } from "../../lesson.ts"
import { Chat } from "../../page-chat.ts"
import { storeOf } from "../keep-the-conversation/lesson.ts"
import { DEFAULT_STORE, storeDocumentOf } from "../keep-the-conversation/store.source.ts"
import { slowCalculator } from "../tools/config-edit.ts"
import { DEFAULT_MEMORY, MEMORY_INTRO, memoryDocumentOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, TOOLS_HEADER, TOOLS_IMPORTS, toolsBodyOf, toolsDocumentOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS } from "./agent.source.ts"
import { BRANCH_HEADER, BRANCH_IMPORTS, branchDocumentOf, DEFAULT_BRANCH } from "./branch.source.ts"
import { CHAT_INTRO, chatDocumentOf, DEFAULT_RESUME } from "./chat.source.ts"
import { latest, openTurn, resumeIgnores } from "./config-edit.ts"

/** The key prefix the lesson's journals live under in the browser's storage, which every page of the site shares. */
export const STORAGE_PREFIX = "efferent-learn:branches:"

/** The store as lesson 7 wrote it, shown read-only here: the page runs that text, whatever lesson 7's tab holds. */
const STORE_SOURCES: Sources = { store: DEFAULT_STORE }

const memoryNames = { Effect, Layer, Option, CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal, Memory, paired, promptMessage }
const toolsNames = { Effect, Schema, Tool, Toolkit }
const branchNames = { Effect, Sessions, TurnNumber }
/** What chat.ts's `resume` imports, and `chosen`, which the page gives it. */
const resumeNames = (chosen: Option.Option<SessionId>) => ({ Effect, Option, Result, currentFormat, Sessions, chosen })

/**
 * An Effect a file made, run over the sessions the page gives it, to a session's id: the learner's `resume`, or the
 * Effect `branchFrom` gave. The file is untyped JavaScript, so what it needs beyond the sessions is not known before
 * it runs: `programOf` says it needs nothing more, as it says of `main`, and a module it was not given is a defect
 * the page reports. What it gives is held to the kernel's own schema of an id, so nothing about it is assumed.
 */
const sessionIdOf = (made: unknown, gave: string): Effect.Effect<SessionId, { readonly message: string }, Sessions> =>
  Effect.gen(function* () {
    if (!Effect.isEffect(made)) return yield* Effect.fail({ message: `${gave} no Effect. It should give a conversation's id, as the sessions do.` })
    const sessions = yield* Sessions
    const value = yield* Result.match(programOf(Effect.provideService(made, Sessions, sessions)), {
      onFailure: (why) => Effect.fail({ message: why }),
      onSuccess: (program) => Effect.mapError(program, (error) => ({ message: textOf(error) })),
    })
    return yield* Effect.mapError(Schema.decodeUnknownEffect(SessionId)(value), () => ({ message: `${gave} no conversation's id: it gave ${String(JSON.stringify(value))}.` }))
  })

const agentNames = (parts: PageParts, resume: Effect.Effect<SessionId, { readonly message: string }, Sessions>, flatMemory: unknown, tools: unknown, toolsLive: unknown) =>
  Result.map(storeOf(STORE_SOURCES), (store) => ({
    Effect, Stream, LanguageModel, Prompt,
    Core, Sessions, turnStartedEvent, userMessage, callTool, Memory, modelAnswer, Chat,
    kernel: parts.kernel, sessions: parts.sessions,
    // Lesson 7's store, built as written; the page's base goes through it from then on.
    store: (storage: KeyValueStore, options: { readonly prefix: string }) => parts.storeOn(store(storage, options)),
    // The browser's storage, seen through this lesson's prefix: every page of the site shares the real one.
    localStorage: parts.storage,
    // The chat is the page's, and the conversation it shows is the one the learner's `resume` gives.
    chatOn: () => parts.chatWith(resume),
    flatMemory, tools, toolsLive, pane: parts.pane, model: parts.model,
  }))

const NOT_A_BRANCH = "branch.ts did not run: branchFrom is not a function. It should take the conversation and a turn, and give the branch Sessions.fork makes."

/** branch.ts as the page runs it: the learner's `branchFrom`, checked to be a function, or why it is none. */
const branchFromOf = (sources: Sources) =>
  Result.flatMap(runStatements("branch.ts did not run: ", sources.branch ?? "", "branchFrom", branchNames), (made) =>
    typeof made === "function" ? Result.succeed(made) : Result.fail(NOT_A_BRANCH))

/**
 * How the page makes a branch: `branchFrom` called with the conversation shown and the turn pressed. What it gives
 * must be an Effect, which is run over the page's sessions and must give a session's id.
 */
const branchWith: NonNullable<Lesson["branch"]> = (sources, conversation, turn) =>
  Result.map(branchFromOf(sources), (branchFrom) => Effect.gen(function* () {
    const made: unknown = yield* Effect.try({ try: () => Reflect.apply(branchFrom, undefined, [conversation, turn]), catch: (error) => ({ message: textOf(error) }) })
    if (!Effect.isEffect(made)) return yield* Effect.fail({ message: "branchFrom did not give an Effect. It should give the branch, as sessions.fork does." })
    return yield* sessionIdOf(made, "branchFrom gave")
  }))

/** memory.ts, tools.ts, chat.ts, branch.ts, then agent.ts, as the page runs them: main, ready to run. */
export const evaluateLesson = (sources: Sources, parts: PageParts): Result.Result<Effect.Effect<unknown, unknown>, string> =>
  Result.flatMap(run("memory.ts did not run: ", sources.memory ?? "", memoryNames), (memory) => {
    if (!Layer.isLayer(memory)) return Result.fail("memory.ts did not run: flatMemory is not a layer. It should be Layer.succeed(Memory, …).")
    return Result.flatMap(runStatements("tools.ts did not run: ", toolsBodyOf(sources.tools ?? ""), "{ tools, toolsLive }", toolsNames), (made) => {
      const tools = named(made, "tools")
      const toolsLive = named(made, "toolsLive")
      if (!Layer.isLayer(toolsLive)) return Result.fail("tools.ts did not run: toolsLive is not a layer. It should be tools.toLayer({ … }).")
      return Result.flatMap(run("chat.ts did not run: ", sources.chat ?? "", resumeNames(parts.chosen)), (resume) => {
        if (!Effect.isEffect(resume)) return Result.fail("chat.ts did not run: resume is not an Effect. It should give the conversation to go on with.")
        // A branch.ts that makes no function refuses the build, as any file that makes the wrong thing does.
        return Result.flatMap(branchFromOf(sources), () =>
          Result.flatMap(agentNames(parts, sessionIdOf(resume, "chat.ts's resume gave"), parts.watchMemory(memory), tools, toolsLive), (names) =>
            Result.flatMap(runStatements("agent.ts did not run: ", sources.agent ?? "", "main", names), (main) => programOf(main))))
      })
    })
  })

export const branches: Lesson = {
  slug: "branches",
  files: [
    {
      id: "branch", label: "branch.ts", defaultText: DEFAULT_BRANCH, documentOf: branchDocumentOf, editableFrom: BRANCH_HEADER.length, formatPrefix: "",
      sections: [{ id: "imports", label: "imports", range: () => ({ from: 0, to: BRANCH_IMPORTS.length }) }], folded: [], readOnly: false,
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
      id: "store", label: "store.ts", defaultText: "", documentOf: () => storeDocumentOf(DEFAULT_STORE), editableFrom: storeDocumentOf(DEFAULT_STORE).length, formatPrefix: "",
      sections: [], folded: [], readOnly: true,
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
  mainFile: "branch",
  chips: ["My name is Ana.", "What did I say earlier?", "What is 12 * 3?", "Remember to buy milk."],
  three: ["My name is Ana.", "What is 12 * 3?", "What did I say earlier?"],
  // No button of the page sends a fill: the type asks for one, and it is the same three.
  fill: ["My name is Ana.", "What is 12 * 3?", "What did I say earlier?"],
  controls: {},
  experiments: {
    latest: { file: "branch", apply: latest },
    "open-turn": { file: "branch", apply: openTurn },
    "slow-calculator": { file: "tools", apply: slowCalculator },
    "resume-ignores": { file: "chat", apply: resumeIgnores },
  },
  evaluate: evaluateLesson,
  branch: branchWith,
  durable: { prefix: STORAGE_PREFIX },
}
