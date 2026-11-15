// Lesson 11's experiments edit the learner's code in place, so the code and
// the buttons never disagree. A piece the learner rewrote beyond recognition
// is left alone (None) rather than guessed at.
import { Option } from "effect"
import { WRAPPED } from "./memory.source.ts"
import { HANDLERS_START, TOOLKIT } from "./tools.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** memory.ts with no wrapper: the kernel's flat memory as it is. */
export const UNWRAPPED = `// No wrapper: each request is sent the conversation alone. The facts are still stored, and the
// model is sent none of them unless it calls recallFacts, the tool this experiment adds to
// tools.ts.
export const memory = flatMemory`

/** The `recall-tool` experiment's edit of memory.ts: the wrapper goes. */
export const withoutWrapper = swap(WRAPPED, UNWRAPPED)

/** The tool the `recall-tool` experiment adds, and the toolkit with it. */
export const RECALL_TOOLKIT = `// A tool of your own that reads the facts. Nothing sends them now: the model must think to call it.
// It reads the memory session, so it declares the sessions it reads through.
const recallFacts = Tool.make("recallFacts", {
  description: "List every fact remembered from earlier conversations, each with its id.",
  success: Schema.Array(Schema.String),
  dependencies: [Sessions],
})

// The agent's own tools, and the kernel's two that remember: one toolkit, each tool with its
// own type.
export const tools = Toolkit.merge(Toolkit.make(calculator, recallFacts), factTools)
`

/** The start of the handlers with the tool's own: the facts that stand, a line each, as the kernel's note lists them. */
export const RECALL_HANDLERS_START = `// What the agent's own tools do when they are called. They run here, in your browser.
// What the kernel's two tools do is the kernel's: agent.ts provides it, as factHandlers.
export const toolsLive = Toolkit.make(calculator, recallFacts).toLayer({
  // The facts that stand, a line each with its id. A store that cannot be read is a defect.
  recallFacts: () =>
    Effect.orDie(
      Effect.map(rememberedFacts, (facts) => facts.map((fact) => \`\${fact.id}: \${fact.text}\`)),
    ),
`

/** The `recall-tool` experiment's edit of tools.ts: a tool of the lesson's own that returns the facts, in the toolkit, with its handler. */
export const withRecallTool = (tools: string): Option.Option<string> =>
  Option.flatMap(swap(TOOLKIT, RECALL_TOOLKIT)(tools), swap(HANDLERS_START, RECALL_HANDLERS_START))

/** memory.ts with a wrapper of the learner's own, over the kernel's parts, that puts the facts before the conversation. */
export const FACTS_FIRST = `// A wrapper of your own, written over the kernel's parts: the facts go first, before the
// conversation. What it adds changes whenever a fact is learned or forgotten, and every message
// after it moves with it.
const factsFirst = (limit) => (inner) =>
  Layer.effect(
    Memory,
    Effect.gen(function* () {
      const below = yield* Memory // the memory it wraps
      const sessions = yield* Sessions
      return Memory.of({
        context: (session) =>
          Effect.gen(function* () {
            const context = yield* below.context(session)
            // The facts that stand, read from the memory session, and those this question is sent.
            const facts = yield* Effect.provideService(rememberedFacts, Sessions, sessions)
            const chosen = relevant(facts, questionOf(yield* session.journal), limit)
            if (chosen.length === 0) return context
            return [{ role: "user", content: factsNote(chosen) }, ...context]
          }),
      })
    }),
  ).pipe(Layer.provide(inner))

export const memory = factsFirst(5)(flatMemory)`

/** The `facts-first` experiment: the learner's own wrapper in place of the kernel's. */
export const factsFirst = swap(WRAPPED, FACTS_FIRST)

/** memory.ts sending one fact at most. */
export const LIMIT_ONE = `// The memory a conversation reads with, wrapped: each request is sent the conversation, then one
// fact at most. With more facts than that, one that shares a word with the question comes first,
// then the newest.
export const memory = withFacts({ limit: 1 })(flatMemory)`

/** The `limit-one` experiment: a limit of one fact. */
export const limitOne = swap(WRAPPED, LIMIT_ONE)
