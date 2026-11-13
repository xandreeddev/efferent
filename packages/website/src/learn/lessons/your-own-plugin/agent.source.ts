// The one source of truth for lesson 3's agent.ts: lesson 2's program, with
// two plugins of the learner's own from plugin.ts provided in main. The page shows IMPORTS (read-only, folded)
// above the code the learner edits, and runs that text as written;
// program.test.ts compiles and runs this exact text on the kernel.

/** Read-only: what the program imports. */
export const IMPORTS = `import { Effect, Option, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { assistantMessage, kernel, Sessions, toolResult, userMessage } from "@xandreed/core/kernel"
import { inProcessJournal, Memory, sessions } from "@xandreed/sdk/kernel"
import { Chat, chatOn } from "./chat.ts"
import { flatMemory } from "./memory.ts"
import { meter, withClock } from "./plugin.ts"
import { tools, toolsLive } from "./tools.ts"`

/** What the learner edits: the system text, the step limit, running a call, one turn, the program and main. */
export const DEFAULT_AGENT = `// The system text: code, sent first in every prompt, never stored.
const system = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."

// How many times one turn may call the model before it gives up.
const MAX_STEPS = 5

// Run one tool call. A tool that fails, or a call the model got wrong, is an answer too:
// the model reads it and goes on.
const runTool = (toolkit, call) =>
  toolkit.handle(call.name, call.params).pipe(
    Effect.flatMap(Stream.runLast),
    Effect.map(
      Option.match({
        onNone: () => toolResult(call, null),
        onSome: (last) => toolResult(call, last.encodedResult, last.isFailure),
      }),
    ),
    // A failure (the tool's own, an unknown tool, wrong parameters), or a bug in a tool: an answer marked failed.
    Effect.catch((error) => Effect.succeed(toolResult(call, error.message ?? error, true))),
    Effect.catchDefect((defect) => Effect.succeed(toolResult(call, String(defect), true))),
  )

// One turn: a loop. The model answers, or asks for tools; their results are stored,
// and the model is asked again.
const turn = (message) =>
  Effect.scoped(
    Effect.gen(function* () {
      const chat = yield* Chat
      const sessions = yield* Sessions
      const memory = yield* Memory
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* tools

      const session = yield* sessions.open(chat.session)
      // Store your message, and every one that waited behind it: this turn answers them all.
      const waiting = yield* chat.drain
      for (const text of [message, ...waiting]) {
        yield* session.append(userMessage(text))
      }

      for (let step = 1; step <= MAX_STEPS; step++) {
        const history = yield* memory.context(session)
        const prompt = Prompt.make([{ role: "system", content: system }, ...history])

        // Offer the tools, but run none: this loop runs the calls. A call the model got wrong
        // comes through as it is ("deferred"), so it can be answered as a failure.
        const parts = yield* model
          .streamText({ prompt, toolkit, disableToolCallResolution: true, toolCallValidation: "deferred" })
          .pipe(
            Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
            Stream.tap((part) => (part.type === "text-delta" ? chat.stream(part.delta) : Effect.void)),
            Stream.runCollect,
          )
        const text = parts
          .filter((part) => part.type === "text-delta")
          .map((part) => part.delta)
          .join("")
        const calls = parts.filter((part) => part.type === "tool-call")

        // Store the answer with the calls it made. No call: the turn is done.
        yield* session.append(assistantMessage(text, { toolCalls: calls }))
        if (calls.length === 0) return text

        // Run each call, and store its result.
        for (const call of calls) {
          yield* chat.status(\`step \${step}: \${call.name}\`)
          const result = yield* runTool(toolkit, call)
          yield* session.append(result)
        }

        // Messages you sent while it worked steer it: they join this turn before the model is asked again.
        // At the last step there is no next call to see them: they wait for a turn of their own.
        if (step < MAX_STEPS) {
          const steers = yield* chat.drain
          for (const steer of steers) {
            yield* session.append(userMessage(steer))
          }
        }
      }
      return \`I stopped after \${MAX_STEPS} steps.\`
    }),
  )

// The program: it runs as long as the page is open.
const program = Effect.scoped(
  Effect.gen(function* () {
    const chat = yield* Chat

    // On boot, the plugins main provides set up: the meter hooks its events there, not here.
    // Then, on each message you send: one turn, in order.
    yield* Stream.runForEach(chat.messages, (message) =>
      turn(message).pipe(
        Effect.flatMap((text) => chat.reply(text)),
        Effect.catch((error) => chat.fail(error)),
      ),
    )
  }),
)

// Run it: give the program the modules it asks for. Each can use the ones given after it.
// \`pane\` and \`model\` come from the page: the chat on the right, and the model you picked.
const main = program.pipe(
  Effect.provide(toolsLive), // what each tool does when it is called
  Effect.provide(meter), // your event plugin: it counts what each turn cost
  Effect.provide(withClock(flatMemory)), // your wrapper: the flat memory, with the time after it
  Effect.provide(chatOn(pane)), // the chat pane: your messages in, answers out
  Effect.provide(sessions()), // conversations and their turns
  Effect.provide(inProcessJournal()), // where every record is kept
  Effect.provide(kernel()), // events every module can hook
  Effect.provide(model), // the model you picked
)`

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run: what the page leaves
 * untyped is typed (the turn's message, a call, the toolkit), and `pane` and
 * `model` are the parameters of `run`, which returns `main`.
 */
export const moduleOf = (agent: string): string => `${IMPORTS.replace('import { Chat, chatOn } from "./chat.ts"', 'import { Chat, chatOn } from "./chat.ts"\nimport type { ChatPane } from "./chat.ts"')}
import type { Layer } from "effect"
import type { Toolkit } from "effect/ai"

export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>) => {
${agent
  .replace("const turn = (message) =>", "const turn = (message: string) =>")
  .replace(
    "const runTool = (toolkit, call) =>",
    "const runTool = (toolkit: Toolkit.WithHandler<typeof tools.tools>, call: { readonly id: string; readonly name: string; readonly params: unknown }) =>",
  )
  .replace("toolkit.handle(call.name, call.params)", "toolkit.handle(call.name as keyof typeof tools.tools, call.params as never)")}
  return main
}
`
