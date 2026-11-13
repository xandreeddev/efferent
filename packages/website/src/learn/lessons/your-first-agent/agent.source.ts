// The one source of truth for lesson 1's agent.ts. The page shows IMPORTS
// (read-only, folded) above the code the learner edits: the system text, one
// turn, the program, and main, which gives the program its modules. The page
// runs that text as written; program.test.ts compiles and runs this exact
// text on the kernel, so what is shown cannot drift.

/** Read-only: what the program imports. */
export const IMPORTS = `import { Effect, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { assistantMessage, Core, kernel, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import { inProcessJournal, Memory, sessions } from "@xandreed/sdk/kernel"
import { Chat, chatOn } from "./chat.ts"
import { flatMemory } from "./memory.ts"`

/** What the learner edits: the system text, one turn, and the program. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_PROGRAM = `// The system text: code, sent first in every prompt, never stored.
const system = "You are a friendly tutor. Keep answers short."

// One turn: what the agent does with one message.
// Everything inside runs in one scope: the turn opened below closes when it ends.
const turn = (message) =>
  Effect.scoped(
    Effect.gen(function* () {
      const chat = yield* Chat
      const sessions = yield* Sessions
      const memory = yield* Memory
      const model = yield* LanguageModel.LanguageModel

      // Open a turn. It closes when this scope ends: answered, failed or stopped.
      const session = yield* sessions.open(chat.session)

      // Store your message, and every one that waited behind it: this turn answers them all.
      // The journal holds the conversation, and only that.
      const waiting = yield* chat.drain
      for (const text of [message, ...waiting]) {
        yield* session.append(userMessage(text))
      }

      // Ask memory for the context: what of the conversation the model sees.
      const history = yield* memory.context(session)

      // The prompt: the system text first, then the context. Built fresh every time, never stored.
      const prompt = Prompt.make([{ role: "system", content: system }, ...history])

      // Call the model. Show each piece as it streams in, and join them into the answer.
      const answer = yield* model.streamText({ prompt }).pipe(
        Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
        Stream.filter((part) => part.type === "text-delta"),
        Stream.map((part) => part.delta),
        Stream.tap((piece) => chat.stream(piece)),
        Stream.mkString,
      )

      // Store the answer, so the next turn's context has it. Return it.
      yield* session.append(assistantMessage(answer))
      return answer
    }),
  )

// The program: it runs as long as the page is open.
// Its scope holds what it sets up on boot, the hook below, until the program stops.
const program = Effect.scoped(
  Effect.gen(function* () {
    const chat = yield* Chat
    const core = yield* Core

    // On boot: hook an event, as a Neovim autocmd would. Here, the chat's status line names each turn.
    // \`wait\` holds the turn until the hook is done, so the status is set before the answer comes.
    yield* core.on(turnStartedEvent, ({ data }) => chat.status(\`turn \${data.turn}\`), {
      name: "boot",
      wait: true,
    })

    // Then, for each message you send: a turn, in order. Those sent meanwhile wait, and the next turn takes them all.
    yield* Stream.runForEach(chat.messages, (message) =>
      turn(message).pipe(
        Effect.flatMap((text) => chat.reply(text)),
        Effect.catch((error) => chat.fail(error)),
      ),
    )
  }),
)`

/** How the program is run, with the modules it asks for. \`pane\` and \`model\` come from the page. */
export const RUN = `// Run it: give the program the modules it asks for. Each can use the ones given after it.
// \`pane\` and \`model\` come from the page: the chat on the right, and the model you picked.
const main = program.pipe(
  Effect.provide(flatMemory), // what of the journal the model sees
  Effect.provide(chatOn(pane)), // the chat pane: your messages in, answers out
  Effect.provide(sessions()), // conversations and their turns
  Effect.provide(inProcessJournal()), // where every record is kept
  Effect.provide(kernel()), // events every module can hook
  Effect.provide(model), // the model you picked
)`

/** The first text of the read-only run section (the editor finds the section by it). */
export const RUN_START_MARK = "// Run it:"

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** What the learner edits as the lesson starts: the program, then main. */
export const DEFAULT_AGENT = `${DEFAULT_PROGRAM}\n\n${RUN}`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run: the turn's message
 * typed, and `pane` and `model` the parameters of `run`, which returns `main`.
 */
export const moduleOf = (agent: string): string => `${IMPORTS.replace('import { Chat, chatOn } from "./chat.ts"', 'import { Chat, chatOn } from "./chat.ts"\nimport type { ChatPane } from "./chat.ts"')}
import type { Layer } from "effect"

export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>) => {
${agent.replace("const turn = (message) =>", "const turn = (message: string) =>")}
  return main
}
`
