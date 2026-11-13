// The one source of truth for lesson 4's agent.ts: the chat's agent and its
// helper, each a run of loop.ts's runAgent with its own system text, tools and
// hooks, the helper in a session of its own (ADR 0006). The page shows the
// imports (read-only, folded) above the code the learner edits, and runs it as
// written; program.test.ts compiles and runs this exact text.

/** Read-only: what the program imports. */
export const IMPORTS = `import { Effect, Layer, Stream } from "effect"
import { kernel, Sessions } from "@xandreed/core/kernel"
import { inProcessJournal, sessions } from "@xandreed/sdk/kernel"
import { Chat, chatOn } from "./chat.ts"
import { runAgent } from "./loop.ts"
import { flatMemory } from "./memory.ts"
import { delegateLive, Helper, helperTools, helperToolsLive, tools } from "./tools.ts"`

/** What the learner edits. */
export const DEFAULT_AGENT = `// The system texts: the chat's agent and its helper. Code, sent first, never stored.
const system = "You are a helpful assistant. Hand a task to a helper with delegate, then answer in one short sentence."
const helperSystem = "You are a helper. Do the task you are given, then answer in one short sentence."

// The helper: an agent of its own, in a session of its own whose parent is the chat's.
const helperLive = Layer.effect(
  Helper,
  Effect.gen(function* () {
    const chat = yield* Chat
    const sessions = yield* Sessions
    const toolkit = yield* helperTools
    // What the helper's turns run with: the memory and the model main provides.
    const services = yield* Effect.context()
    // Its hooks: its words stay out of the chat, its status says it is the helper, nothing steers it.
    const hooks = { stream: () => Effect.void, status: (text) => chat.status(\`helper: \${text}\`), drain: Effect.succeed([]) }
    const helper = runAgent({ system: helperSystem, toolkit, hooks })
    return Helper.of({
      ask: (task) =>
        Effect.scoped(
          Effect.gen(function* () {
            // A session of its own, a child of the chat's, and a turn in it while the chat's is open.
            const session = yield* sessions.create({ owner: "helper", parent: chat.session })
            const answer = yield* helper(yield* sessions.open(session), [task])
            return { answer, session }
          }),
        ).pipe(
          Effect.provide(services),
          Effect.mapError((error) => error.message ?? String(error)),
        ),
    })
  }),
)

// The program: each message you send is one turn of the chat's agent, in the chat's session.
const program = Effect.gen(function* () {
  const chat = yield* Chat
  const sessions = yield* Sessions
  const toolkit = yield* tools
  const agent = runAgent({ system, toolkit, hooks: chat })

  yield* Stream.runForEach(chat.messages, (message) =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* sessions.open(chat.session)
        yield* chat.status(\`turn \${session.turn}\`)
        const waiting = yield* chat.drain
        const answer = yield* agent(session, [message, ...waiting])
        yield* chat.status(\`turn \${session.turn}: answered\`)
        return answer
      }),
    ).pipe(
      Effect.flatMap((text) => chat.reply(text)),
      Effect.catch((error) => chat.fail(error)),
    ),
  )
})

// Run it: give the program the modules it asks for. Each can use the ones given after it.
const main = program.pipe(
  Effect.provide(delegateLive), // what delegate does: ask the helper
  Effect.provide(helperLive), // the helper: an agent of its own
  Effect.provide(helperToolsLive), // what the helper's tools do
  Effect.provide(flatMemory), // what of a session's journal its model sees
  Effect.provide(chatOn(pane)), // the chat pane: your messages in, answers out
  Effect.provide(sessions()), // sessions and their turns: the chat's, and the helper's
  Effect.provide(inProcessJournal()), // where every record is kept
  Effect.provide(kernel()), // events every module can hook
  Effect.provide(model), // the model you picked, for both agents
)`

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run: what the page leaves untyped is typed, and `pane` and
 * `model` are the parameters of `run`, which returns `main`.
 */
export const moduleOf = (agent: string): string => `${IMPORTS.replace('import { Chat, chatOn } from "./chat.ts"', 'import { Chat, chatOn } from "./chat.ts"\nimport type { ChatPane } from "./chat.ts"')}
import { LanguageModel } from "effect/ai"
import { Memory } from "@xandreed/sdk/kernel"

export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>) => {
${agent
  .replace("const services = yield* Effect.context()", "const services = yield* Effect.context<Memory | LanguageModel.LanguageModel>()")
  .replace("status: (text) => chat.status(", "status: (text: string) => chat.status(")
  .replace("drain: Effect.succeed([]) }", "drain: Effect.succeed<ReadonlyArray<string>>([]) }")
  .replace("ask: (task) =>", "ask: (task: string) =>")
  .replace("Effect.mapError((error) => error.message ?? String(error)),", "Effect.mapError((error: unknown) => (error instanceof Error ? error.message : String(error))),")}
  return main
}
`
