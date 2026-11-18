// The one source of truth for lesson 18's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) with four changes, none of
// them in the loop. After each turn's answer the program hands the turn to
// curator.ts's `keep`, and takes the next message only once it is done, so a
// question's memory reads what the turn before it added. The memory it
// provides is memory.ts's, the flat memory wrapped with what is kept; beside
// it, curator.ts's curator over the curator's model, which the page gives. And
// the boot hook names only the conversation's turns: keeping a turn opens
// turns of its own, on the knowledge session. The text is the base's with
// named pieces replaced; program.test.ts checks the base still holds each,
// and compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"
import { BOOT_HOOK, FLAT_LINE } from "../remember/agent.source.ts"

/** What this lesson replaces in the base's imports, as `[from, to]`: memory.ts gives `memory`, and curator.ts the curator and `keep`. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ['import { flatMemory } from "./memory.ts"', 'import { curatorOn, keep } from "./curator.ts"\nimport { memory } from "./memory.ts"'],
]

/** This lesson's boot hook: it names the conversation's turns, and passes over a turn on the knowledge session. */
export const CHAT_HOOK = `    // On boot: hook an event, to run code when it fires. Here, the chat's status line names each
    // turn of the conversation. Keeping what a turn said opens turns too, on the knowledge
    // session: the hook passes those over.
    yield* core.on(
      turnStartedEvent,
      (event) =>
        event.session === chat.session ? chat.status(\`turn \${event.data.turn}\`) : Effect.void,
      { name: "boot", wait: true },
    )
`

/** The base's handling of each message: one turn, its answer or its failure. */
const EACH_MESSAGE = `    // Then, on each message you send: one turn, in order.
    yield* Stream.runForEach(chat.messages, (message) =>
      turn(message).pipe(
        Effect.flatMap((text) => chat.reply(text)),
        Effect.catch((error) => chat.fail(error)),
      ),
    )
`

/** This lesson's: once the turn is answered, the curator keeps what it said, before the next message is taken. */
export const EACH_KEPT = `    // Then, on each message you send: one turn, in order. Once it is answered, the curator keeps
    // what the turn said (curator.ts), before the next message is taken: the next request's
    // memory reads what this turn added.
    yield* Stream.runForEach(chat.messages, (message) =>
      turn(message).pipe(
        Effect.flatMap((text) => chat.reply(text)),
        Effect.catch((error) => chat.fail(error)),
        Effect.andThen(keep),
      ),
    )
`

/** The base's line that says what the page gives. */
const PAGE_GIVES = "// `pane` and `model` come from the page: the chat on the right, and the model you picked.\n"

/** This lesson's: the page gives the curator's model too. */
export const PAGE_GIVES_CURATOR = `// \`pane\`, \`model\` and \`curatorModel\` come from the page: the chat on the right, the model you
// picked, and the model the curator asks: the gateway's when you picked one, else Echo.
`

/** main's lines for memory.ts's memory and curator.ts's curator. */
export const MEMORY_LINE = "  Effect.provide(memory), // what the model sees: the conversation, then what is kept about what it names\n"
export const CURATOR_LINE = "  Effect.provide(curatorOn(curatorModel)), // who keeps what each turn said, over the curator's model\n"

/** What this lesson replaces in the base's program, as `[from, to]`. program.test.ts fails when the base no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [BOOT_HOOK, CHAT_HOOK],
  [EACH_MESSAGE, EACH_KEPT],
  [PAGE_GIVES, PAGE_GIVES_CURATOR],
  [FLAT_LINE, `${MEMORY_LINE}${CURATOR_LINE}`],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, over this lesson's memory and curator. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as the base's: `run` states that its program needs nothing
 * more, so a program that leaves out the curator does not compile. The curator's model is the page's, a parameter
 * of `run` beside the model picked.
 */
export const moduleOf = (agent: string): string =>
  typedModule(IMPORTS, agent).replace(
    "export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>): Effect.Effect<unknown, unknown> => {",
    "export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>, curatorModel: Layer.Layer<LanguageModel.LanguageModel>): Effect.Effect<unknown, unknown> => {",
  )
